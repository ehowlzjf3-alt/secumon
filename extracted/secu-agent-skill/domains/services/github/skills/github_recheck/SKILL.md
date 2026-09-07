---
name: github_recheck
description: GitHub E2E remediation recheck worker contract.
domain: github
when_to_use: GitHub E2E pipeline verifies claimed remediation.
triggers: github_recheck; github remediation recheck; github verify fixed
---

# github_recheck

Verify remediation for one repo-scoped GitHub report thread.

- Prefer API HEAD content detail refetch for paths captured from the original
  report, then fall back to clone/current-HEAD inspection only when needed.
- Compare original masked secret signatures against HEAD findings.
- Treat GitHub content 404/not_found as a positive removal signal for that
  path, but do not treat non-file, non-base64, binary, or otherwise
  non-inspectable content responses as fixed; record those as `unknown` so the
  thread remains retryable.
- Preserve API rate-limit/abuse-limit refetch failures as `limit_failed`
  evidence on `unknown` results; do not treat them as fixed or as clone fallback
  triggers.
- If any result is `unknown`, keep the thread `recheck_requested` and do not
  send a recheck result mail yet; schedule the retry with `retry_after`
  (default 8 hours) so the worker does not immediately reclaim it.
- Retry attempts are bounded like SMB reply verification. Once the thread's
  `attempt_count` exceeds the service recheck cap, the runtime escalates the
  thread instead of sending more guidance or rechecking again.
- Mark individual findings resolved only when the original signature is absent
  from an inspectable HEAD response, or the original path is confirmed missing.
- Preserve `historical_only` exposure as history cleanup guidance unless HEAD still contains the value.
- Record structured `github_recheck_result` rows.
- Send the recheck result through the core delivery gate. Finalize the thread
  and resolve lifecycle findings only after the result delivery reports `sent`;
  dry-run or failed delivery leaves the thread retryable as `recheck_requested`.
- Before claiming recheck work, handle `awaiting_owner` threads whose latest
  inbound reply is `classified_how_to_question`: send one reply-style guidance
  mail with the original message quoted, record `outbound_how_to_guidance`
  only after `sent`, and suppress duplicate guidance for the same inbound. A
  dry-run or delivery failure keeps the thread `awaiting_owner` with
  `retry_after` scheduled and counts as a bounded guidance attempt.
- Do not mutate GitHub or validate credentials.
