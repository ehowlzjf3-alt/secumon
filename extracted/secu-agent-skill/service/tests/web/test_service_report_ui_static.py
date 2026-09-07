from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_dev_web_ui_uses_existing_domain_apis_and_auto_filters() -> None:
    html = (ROOT / "domains/dev_web/webapp/ui/index.html").read_text(encoding="utf-8")

    assert "DevWeb E2E Pipeline" in html
    assert "getJSON('/api/pipeline/overview'" in html
    assert "getJSON('/api/dev-web/targets'" in html
    assert "getJSON('/api/dev-web/reports'" in html
    assert "postJSON('/api/control/'+component" in html
    assert "function scheduleFilter" in html
    assert "oninput=\"targetState.q=this.value;scheduleFilter()\"" in html
    assert "oninput=\"reportState.q=this.value;scheduleFilter()\"" in html
    assert "onclick=\"applyReportFilters()\">적용" not in html


def test_github_report_ui_renders_scan_method_summary() -> None:
    html = (ROOT / "domains/services/github/webapp/ui/index.html").read_text(encoding="utf-8")

    assert "function scanMethodPills" in html
    assert "function findingScanTrace" in html
    assert "function recheckTrace" in html
    assert "function recheckEvidence" in html
    assert "api_code_search_detail_scan" in html
    assert "api_head_detail_refetch" in html
    assert "clone_head_rescan" in html
    assert "candidate_source" in html
    assert "candidate_query" in html
    assert "detail_fetched" in html
    assert "missing_reason" in html
    assert "head_sha" in html
    assert "v.auth_failed" in html
    assert "v.limit_failed" in html
    assert "r.verdict==='unknown'?'unknown':(v.matched===true?'matched':(v.matched===false?'clean':'unknown'))" in html
    assert "scanMethodPills(t)" in html
    assert "recheckTrace(r)" in html
    assert "recheckEvidence(r)" in html
    assert "function scheduleReportFilterApply" in html
    assert "function applyReportCycle" in html
    assert "oninput=\"scheduleReportFilterApply()\"" in html
    assert "onchange=\"applyReportCycle()\"" in html
    assert "onchange=\"applyReportFilters()\"" in html
    assert "cycle_key:reportState.cycleKey" in html
    assert "onclick=\"applyReportFilters()\">적용" not in html
    assert "const canClose=t.can_close_exception??t.status==='exception_review'" in html
    assert "const canReject=t.can_reject_exception??t.status==='exception_review'" in html
    assert "const exceptionActions=(canClose||canReject)" in html
    assert "Approve exception" in html
    assert "Reject exception" in html
    assert "verificationSummary(t)}${scanMethodPills(t)" in html
    assert "<th>Scan</th><th>Summary</th>" in html
    assert "findingScanTrace(f)" in html
    assert "function messageBody(m)" in html
    assert 'if(m.body_html)return `<iframe class="message-html" sandbox="" srcdoc="${esc(m.body_html)}"></iframe>`' in html
    assert 'return `<div class="message-body">${esc(m.body_excerpt||\'\')}</div>`' in html
    assert "${messageBody(m)}" in html
    assert ".message-html{height:160px;min-height:120px;max-height:220px" in html
    assert 't.report_html?`<iframe sandbox="" srcdoc="${esc(t.report_html)}"></iframe>`' in html


def test_confluence_report_ui_renders_tags_verification_and_scan_summary() -> None:
    html = (ROOT / "domains/services/confluence/webapp/ui/index.html").read_text(encoding="utf-8")

    assert "function scanMethodPills" in html
    assert "function findingScanTrace" in html
    assert "function recheckTrace" in html
    assert "function recheckEvidence" in html
    assert "function verificationSummary" in html
    assert "function tagPills" in html
    assert "api_cql_search_detail_scan" in html
    assert "confluence_surface_refetch" in html
    assert "candidate_query" in html
    assert "surface_labels" in html
    assert "verification.auth_failed" in html
    assert "verification.limit_failed" in html
    assert "r.verdict==='unknown'?'unknown':(verification.matched===true?'matched':(verification.matched===false?'clean':'unknown'))" in html
    assert "verification.status_code" in html
    assert "tagPills(t.finding_tags)" in html
    assert "verificationSummary(t)" in html
    assert "scanMethodPills(t)" in html
    assert "recheckTrace(r)" in html
    assert "recheckEvidence(r)" in html
    assert "function scheduleReportFilterApply" in html
    assert "oninput=\"scheduleReportFilterApply()\"" in html
    assert "onchange=\"applyReportFilters()\"" in html
    assert "onclick=\"applyReportFilters()\">적용" not in html
    assert "const canClose=t.can_close_exception??t.status==='exception_review'" in html
    assert "const canReject=t.can_reject_exception??t.status==='exception_review'" in html
    assert "const exceptionActions=(canClose||canReject)" in html
    assert "예외 승인" in html
    assert "예외 반려" in html
    assert "<th>Scan</th><th>Summary</th>" in html
    assert "<th>Recheck</th><th>근거</th>" in html
    assert "function messageBody(m)" in html
    assert 'if(m.body_html)return `<iframe class="message-html" sandbox="" srcdoc="${esc(m.body_html)}"></iframe>`' in html
    assert 'return `<div class="message-body">${esc(m.body_excerpt||\'\')}</div>`' in html
    assert "${messageBody(m)}" in html
    assert ".message-html{height:160px;min-height:120px;max-height:220px" in html
    assert 't.report_html?`<iframe sandbox="" srcdoc="${esc(t.report_html)}"></iframe>`' in html
