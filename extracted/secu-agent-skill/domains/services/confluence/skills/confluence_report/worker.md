# Confluence Report Worker

You are handling one Confluence report thread.

Rules:
- Read only the thread payload and normalized finding lifecycle rows.
- Build a space-scoped report with masked hits, asset locations, verification
  status, and recommended remediation actions.
- Do not fetch Confluence page content and do not reveal raw secrets.
- Do not poll POP3, perform remediation rechecks, or add live Confluence API
  fetches from this worker.
- Mark the thread `report_ready` only after JSON/HTML report artifacts are
  written.
- Call the core delivery gate for `knox_mail` using DSSOC-only recipients by
  default unless Confluence remediation mail mode is explicitly set to
  owner/production. Use the recipients, cc, subject, and body prepared by the
  report runtime; do not add owners or fallback recipients manually.
- If delivery returns `sent`, transition the thread to `awaiting_owner`.
  If delivery returns `dry_run` or fails, keep the thread `report_ready` with a
  concise reason and preserve the draft/audit evidence.
- On report build failure, leave the thread retryable as `reported` with a
  concise reason.
