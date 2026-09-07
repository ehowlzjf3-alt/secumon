"""Confluence E2E application contracts.

These values are Confluence-domain contracts, not engine defaults. They are
shared by fanout adapters, workers, projections, and tests so the domain plugin
can attach to the domain-neutral engine without hard-coded core branches.
"""
from __future__ import annotations

COMPONENT_CONFLUENCE_SPACE_DISCOVERY = "confluence.space_discovery"
COMPONENT_CONFLUENCE_SPACE_TASK = "confluence.space_task"
COMPONENT_CONFLUENCE_SEARCH_TASK = "confluence.search_task"
COMPONENT_CONFLUENCE_SSO_DISCOVERY = "confluence.sso_discovery"
COMPONENT_CONFLUENCE_SSO_TASK = "confluence.sso_task"
COMPONENT_CONFLUENCE_REPORT = "confluence.report"
COMPONENT_CONFLUENCE_RECHECK = "confluence.recheck"

PHASE_CONFLUENCE_SPACE_DISCOVERY = "space_discovery"
PHASE_CONFLUENCE_SPACE_TASK = "space_task"
PHASE_CONFLUENCE_SEARCH_TASK = "search_task"
PHASE_CONFLUENCE_SSO_DISCOVERY = "sso_discovery"
PHASE_CONFLUENCE_SSO_TASK = "sso_task"
PHASE_CONFLUENCE_REPORT = "space_report"
PHASE_CONFLUENCE_RECHECK = "space_recheck"

CONFLUENCE_SPACE_TASK_PLAN = "confluence_space_task"
CONFLUENCE_SEARCH_TASK_PLAN = "confluence_search_task"
CONFLUENCE_SSO_TASK_PLAN = "confluence_sso_task"
CONFLUENCE_REPORT_PLAN = "confluence_report"
CONFLUENCE_RECHECK_PLAN = "confluence_recheck"
CONFLUENCE_TASK_PLAN = "confluence_task"
CONFLUENCE_E2E_PLAN = "confluence_e2e"

CONFLUENCE_TASK_SKILL = "confluence_task"
CONFLUENCE_REPORT_SKILL = "confluence_report"
CONFLUENCE_RECHECK_SKILL = "confluence_recheck"

CONFLUENCE_SPACE_TASK_SESSION_ID = -635353
CONFLUENCE_SEARCH_TASK_SESSION_ID = -675757
CONFLUENCE_SSO_TASK_SESSION_ID = -645454
CONFLUENCE_REPORT_SESSION_ID = -655555
CONFLUENCE_RECHECK_SESSION_ID = -665656
