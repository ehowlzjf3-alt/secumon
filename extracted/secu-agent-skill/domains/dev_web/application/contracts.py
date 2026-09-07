"""dev_web E2E application contracts.

These values are domain contracts supplied by secu-agent-skill. They are not
core defaults and should not be moved into the engine.
"""
from __future__ import annotations

COMPONENT_DISCOVERY = "dev_web_discovery"
COMPONENT_TASK = "dev_web_task"
COMPONENT_REPORT = "dev_web_report"
COMPONENT_REVERIFY = "dev_web_reverify"

PHASE_DISCOVERY = "discovery"
PHASE_TASK = "task"
PHASE_REPORT = "report"
PHASE_REPLY_VERIFY = "reply_verify"

DEV_WEB_TASK_PLAN = "dev_web_task"
DEV_WEB_REPORT_PLAN = "dev_web_report"
DEV_WEB_REPLY_VERIFY_PLAN = "dev_web_reply_verify"
DEV_WEB_E2E_AGENTS_PLAN = "dev_web_e2e_agents"

DISCOVERY_SESSION_ID = -534343
SA_SESSION_ID = -535353
REPORT_SESSION_ID = -536363
REVERIFY_SESSION_ID = -537373
