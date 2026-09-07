"""SMB application contracts shared by adapters.

These values are domain contracts, not core defaults. Keep them here so workers,
fanout adapters, web projections, and tests cannot drift.
"""
from __future__ import annotations

COMPONENT_COLLECTOR = "collector"
COMPONENT_TASK = "task"
COMPONENT_MAIL = "mail"
COMPONENT_REVERIFY = "reverify"

PHASE_TASK = "task"
PHASE_REPORT_MAIL = "report_mail"
PHASE_REPLY_VERIFY = "reply_verify"
PHASE_REVERIFY = "reverify"

SMB_TASK_PLAN = "smb_task"
SMB_REPORT_MAIL_PLAN = "smb_report_mail"
SMB_REPLY_VERIFY_PLAN = "smb_reply_verify"
SMB_E2E_AGENTS_PLAN = "smb_e2e_agents"

COLLECTOR_SESSION_ID = -424242
SA_SESSION_ID = -434343
MAIL_SESSION_ID = -454545
REVERIFY_SESSION_ID = -474747
