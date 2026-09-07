---
name: dev_web_task
domain: dev_web
description: Worker contract for one dev_web target task.
---

# dev_web_task

Inspect exactly one dev_web target. Use only the target supplied in the worker
prompt.

Required sequence:

1. Run `web_site_sweep(domain='<target url>')`.
2. Open the site with browser tools and traverse visible top/left menus, lists,
   details, settings/admin, integrations, API/token, and export/download views.
3. Read `pages`, `probes`, `api_samples`, `dynamic_responses`, rendered text,
   and XHR/fetch responses.
4. Use `web_fetch` or `web_resource_probe` only for bounded representative
   follow-up.
5. Submit confirmed findings with `dev_web_submit_finding(target_id=<id>, ...)`.
6. Finish with `dev_web_target_set_status(target_id=<id>, status='tasked'|'skipped'|'error', finding_count=N, reason=...)`.

Never submit from keyword or entropy hits alone. A finding needs agent-verified
screen/response evidence, sensitivity classification, and business/system
context. Do not leave the target in progress.
