# dev_web / api

## Pipeline Tools

| Tool | Purpose |
|---|---|
| `run_dev_web_discovery` | Splunk web-log discovery into `dev_web_target`. |
| `dev_web_targets_pending` | Inspect pending target queue. |
| `dev_web_target_set_status` | Mark a target `tasked`, `skipped`, or `error`. |
| `dev_web_submit_finding` | Generic finding submission plus dev_web report-thread transition. |
| `dev_web_build_report` | Build remediation report HTML from DB/evidence only. |
| `dev_web_record_reverify_result` | Persist reverify result and transition report status. |

## Reused Web Tools

`web_site_sweep`, `web_fetch`, `web_resource_probe`, and `web_task_scan` remain
owned by `domains/web`. dev_web uses them as inspection primitives.
