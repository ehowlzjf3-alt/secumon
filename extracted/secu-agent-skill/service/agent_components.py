"""Compatibility re-export for SMB application contracts."""
from __future__ import annotations

from domains.smb.application.contracts import (  # noqa: F401
    COLLECTOR_SESSION_ID,
    COMPONENT_COLLECTOR,
    COMPONENT_TASK,
    COMPONENT_MAIL,
    COMPONENT_REVERIFY,
    SA_SESSION_ID,
    MAIL_SESSION_ID,
    PHASE_TASK,
    PHASE_REPLY_VERIFY,
    PHASE_REPORT_MAIL,
    PHASE_REVERIFY,
    REVERIFY_SESSION_ID,
    SMB_E2E_AGENTS_PLAN,
    SMB_TASK_PLAN,
    SMB_REPLY_VERIFY_PLAN,
    SMB_REPORT_MAIL_PLAN,
)
