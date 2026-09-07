# GitHub Recheck Worker

Input: `task_spec.json` with one repo report thread.

Required behavior:

1. Use read-only API HEAD content detail refetch for the original finding paths
   before falling back to a clone.
2. Scan current HEAD only for remediation status.
3. Compare by secret kind, masked value, and path.
4. Write `now_closed`, `still_open`, or `unknown` recheck results.
   - `404`/`not_found` means the original path disappeared and may be
     `now_closed`.
   - Directory, non-base64, binary, rate-limited, or otherwise non-inspectable
     detail responses are `unknown`, not `now_closed`.
   - Rate-limit/abuse-limit refetch failures must preserve `limit_failed`
     evidence and must not trigger clone fallback.
5. If any result is `unknown`, leave the thread `recheck_requested`, schedule
   `retry_after` (default 8 hours), and do not send a result mail yet.
   Retry attempts are bounded by runtime `attempt_count`; cap-exceeded threads
   are escalated without another recheck or delivery.
6. Otherwise send the recheck result through the core `knox_mail` delivery gate.
7. Resolve lifecycle findings only for `now_closed` after delivery reports
   `sent`; dry-run or delivery failure keeps the thread `recheck_requested`.
8. For how-to inbound replies, send guidance once with the original reply
   quoted and keep the thread `awaiting_owner`; if delivery is dry-run or
   fails, schedule `retry_after` instead of immediately reclaiming it. Sent,
   dry-run, and failed guidance deliveries count toward the same bounded
   attempt cap.
9. If an inbound `body_excerpt` contains an `Original Message` separator,
   classify and act only on the new human reply text before that separator.
   Treat the quoted DSSOC request or prior thread as context, not as the
   owner's latest answer.
10. For guidance or recheck-result mail, preserve the runtime-built
   reply-style subject, reply-all recipients, `In-Reply-To`, `References`, and
   root message metadata. Do not invent recipients or mail-client prefixes
   yourself.

No destructive git or GitHub operation is allowed.
