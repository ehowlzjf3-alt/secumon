# dev_web / schema

## dev_web_target

Per-URL/day tasking queue. Claim unit is one site URL. Status values:
`pending`, `in_progress`, `tasked`, `skipped`, `error`.
Discovery stores all scoped CDEP candidates; `priority_score` only changes
claim order, so dev/stage/test hints do not exclude prod-looking CDEP hosts.

## dev_web_report_thread

Per-site remediation/report queue. Status values include `draft`, `reported`,
`awaiting_reply`, `reply_received`, `reverifying`, `remediated`,
`re_requested`, `partially_remediated`, `exception_review`,
`owner_update_needed`, `owner_reassignment_review`, `reassigned`, `escalated`,
and `closed`.

## dev_web_recheck_result

Audit rows for reply/reverify outcomes. Each row stores verdict, verification
JSON, evidence reference, and error text if any.
