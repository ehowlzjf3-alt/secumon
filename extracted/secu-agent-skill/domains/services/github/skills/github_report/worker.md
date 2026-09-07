# GitHub Report Worker

Input: `task_spec.json` with one `github_report_thread` row.

Required behavior:

1. Load all lifecycle findings referenced by the thread.
2. Build a repo-centered JSON and HTML report.
3. Keep report evidence masked and path/commit-oriented.
   Do not fetch live GitHub content, clone repositories, poll POP3, or perform
   remediation rechecks from this worker.
4. Mark the thread `report_ready` after JSON/HTML is written.
5. Call the core delivery gate for `knox_mail` using the report `deliver_hint`.
   Default recipient policy is DSSOC-only unless GitHub remediation mail mode
   is explicitly set to owner/production. Use the recipients, cc, subject, and
   body prepared by the report runtime; do not add owners or fallback
   recipients manually.
6. If delivery returns `sent`, transition the thread to `awaiting_owner`.
   If delivery returns `dry_run` or fails, keep the thread `report_ready` with
   a concise reason and preserve the draft/audit evidence.

The report is optimized for GitHub remediation, not SMB share remediation.
