---
name: dev_web_report
domain: dev_web
description: Worker contract for one dev_web remediation report.
---

# dev_web_report

Build and deliver one report thread. Do not perform live web probing.

Use `dev_web_build_report(thread_id=<id>)`, then call `deliver` exactly once
with the returned `deliver_hint`. Use the tool-provided subject, HTML, and
recipient policy.
