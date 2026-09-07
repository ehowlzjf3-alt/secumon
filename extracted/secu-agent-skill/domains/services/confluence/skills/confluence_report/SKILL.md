---
name: confluence_report
description: Build Confluence space-scoped remediation reports from normalized confluence findings.
---

# Confluence Report

Use this skill for deterministic Confluence E2E report workers. The worker must
only read normalized `task_type='confluence'` findings, group them by
`space_key`, and write masked JSON/HTML report artifacts.

Do not include raw page bodies, raw secrets, or unmasked credentials in the
report. Keep the report scoped to a single Confluence space thread.

After the report JSON/HTML is persisted, use the Confluence report delivery
policy through the core egress gate. Default delivery is DSSOC-only; owner
delivery requires explicit production mail mode. Move the thread to
`awaiting_owner` only when the gate reports `sent`; dry-run or failed delivery
leaves it `report_ready` for operator review.
