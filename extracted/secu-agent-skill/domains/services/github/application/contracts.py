"""GitHub E2E application contracts.

These values belong to the GitHub domain plugin, not the domain-free engine.
They are shared by service agents, fanout adapters, projections, and tests.
"""
from __future__ import annotations

COMPONENT_GITHUB_DISCOVERY = "github.collector"
COMPONENT_GITHUB_SCAN = "github.scan"
COMPONENT_GITHUB_SEARCH_DISCOVERY = "github.search_discovery"
COMPONENT_GITHUB_SSO_DISCOVERY = "github.sso_discovery"
COMPONENT_GITHUB_SSO_TASK = "github.sso_task"
COMPONENT_GITHUB_REPORT = "github.report"
#: 저장소 담당자 해석. ⚠️ 이 스텝이 없어서 `github_owner.resolve_and_persist` 는
#: 2026-08-29 까지 **호출부가 0개**였다 — finding repo 193개 중 담당자가 있는 건 36개뿐이고
#: 콘솔 티켓 146건이 "담당자 미상" 이었다.
COMPONENT_GITHUB_OWNER = "github.owner"
COMPONENT_GITHUB_RECHECK = "github.recheck"

PHASE_GITHUB_DISCOVERY = "repo_discovery"
PHASE_GITHUB_SCAN = "repo_scan"
PHASE_GITHUB_SEARCH_DISCOVERY = "search_discovery"
PHASE_GITHUB_SSO_DISCOVERY = "sso_discovery"
PHASE_GITHUB_SSO_TASK = "sso_task"
PHASE_GITHUB_REPORT = "repo_report"
PHASE_GITHUB_RECHECK = "repo_recheck"

GITHUB_SCAN_PLAN = "github_scan"
GITHUB_SSO_TASK_PLAN = "github_sso_task"
GITHUB_TASK_PLAN = "github_task"
GITHUB_REPORT_PLAN = "github_report"
GITHUB_RECHECK_PLAN = "github_recheck"
GITHUB_E2E_AGENTS_PLAN = "github_e2e_agents"

GITHUB_TASK_SKILL = "github_task"
GITHUB_SCAN_SKILL = "github_scan"
GITHUB_REPORT_SKILL = "github_report"
GITHUB_RECHECK_SKILL = "github_recheck"

GITHUB_DISCOVERY_SESSION_ID = -524242
GITHUB_SCAN_SESSION_ID = -534343
GITHUB_SSO_TASK_SESSION_ID = -565656
GITHUB_REPORT_SESSION_ID = -545454
GITHUB_RECHECK_SESSION_ID = -575757
