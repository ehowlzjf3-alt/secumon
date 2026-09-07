---
name: github_report
description: GitHub E2E repo report worker contract.
domain: github
when_to_use: GitHub E2E pipeline builds repo-scoped remediation reports.
triggers: github_report; github report; github remediation report
---

# github_report

Build one repo-scoped remediation report from `github_report_thread`.

- Group findings by repository, path, verification status, and source.
- Distinguish `live_in_HEAD` from `historical_only` history exposure.
- Include masked snippets only.
- Recommend GitHub-appropriate actions: rotate credentials, remove from HEAD, clean or restrict history, check sibling repos and CI reuse.
- Preserve report JSON/HTML in `github_report_thread`.
- Use the GitHub report delivery policy, not SMB mail-thread state. Default is
  DSSOC-only delivery through the core egress gate; only explicit production
  mail mode may target owners.
- Transition to `awaiting_owner` only after the delivery gate reports `sent`.
