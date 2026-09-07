---
name: dev_web_reply_verify
domain: dev_web
description: Worker contract for dev_web remediation reply verification.
---

# dev_web_reply_verify

Reverify one dev_web report thread after a remediation reply.

Use the same URL and same origin only. Prefer `web_site_sweep` with small caps,
then focused `web_resource_probe` or `web_fetch` for the original exposed
resource. Record the result with `dev_web_record_reverify_result`.

Then **reply to the owner** — recording alone leaves them with no answer, and the
other domains treat delivery as the terminal step:

- `dev_web_build_reply(thread_id, reply_kind, open_urls=[...])` builds subject/body.
  `reply_kind` mirrors the verdict: `confirmed` (remediated) · `still_exposed` · `partial`.
- Send it with `deliver(action='send', sink_id='knox_mail', ...)` using the returned
  `deliver_hint`.
- Do **not** reply when the verdict is `inconclusive` or `error` — close with the record
  instead. An unsettled judgement is not something to send to an owner.

Recipient policy is enforced downstream (`DEV_WEB_REMEDIATION_MAIL_MODE`, default
`dssoc_only`) — building a reply does not by itself mail the owner.
