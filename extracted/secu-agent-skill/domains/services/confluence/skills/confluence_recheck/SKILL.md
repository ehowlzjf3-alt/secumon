---
name: confluence_recheck
description: Re-fetch Confluence surfaces for remediation verification without changing Confluence content.
---

# Confluence Recheck

Use this skill for deterministic Confluence E2E remediation recheck workers.
The worker may use read-only Confluence API calls to re-fetch page bodies,
comments, attachments, or historical versions referenced by a report thread.

The worker must compare current detector signatures against the original masked
finding signatures. It must never modify Confluence content and must not output
raw secrets.

If any referenced page, comment, attachment, or historical version cannot be
refetched or inspected, record `unknown` and keep the thread retryable as
`recheck_requested`. Do not move technical refetch uncertainty to
`exception_review`; reserve HITL states for human/business reply decisions.
Preserve Confluence API rate-limit/abuse-limit refetch failures as
`limit_failed` evidence on the `unknown` result.
Do not send a recheck result mail for `unknown` technical refetch uncertainty;
schedule `retry_after` (default 8 hours) and retry after the referenced surface
is inspectable. Retry attempts are bounded like SMB reply verification; when
`attempt_count` exceeds the service recheck cap, the runtime escalates instead
of rechecking or sending more guidance.

For determinate `now_closed`/`still_open` results, send a masked result notice
through the core delivery gate. Finalize the thread and resolve findings only
after the delivery reports `sent`; dry-run or failed delivery leaves the thread
retryable as `recheck_requested`.

Before claiming recheck work, handle `awaiting_owner` threads whose latest
inbound reply is `classified_how_to_question`: send one reply-style guidance
mail with the original message quoted, record `outbound_how_to_guidance` only
after `sent`, and suppress duplicate guidance for the same inbound. A dry-run
or delivery failure keeps the thread `awaiting_owner` with `retry_after`
scheduled and counts as a bounded guidance attempt.
