---
name: github_scan
description: GitHub E2E repo scan worker contract.
domain: github
when_to_use: GitHub E2E pipeline scans claimed repositories from github_repo_target.
triggers: github_scan; github repo scan; github e2e scan
---

# github_scan

Scan exactly the claimed repository from `task_spec.json`.

- Use read-only GitHub access only.
- Search first with the GitHub API (`code_search` plus recent commit patch APIs).
- Fetch file or commit-patch details only for API-selected candidates.
- If API search returns candidate files but every file detail refetch is missing,
  mark the target `error`; do not close it as cleanly tasked.
- Use clone/worktree scanning only as a bounded fallback when the API is unavailable.
- Never print or persist the configured service token.
- Store only masked evidence, repo/path/line metadata, source (`worktree` or `history`), and verification status.
- Upsert `task_type='github'` lifecycle findings and link them into the repo-scoped GitHub report thread.
- Mark the claimed `github_repo_target` `tasked`, `skipped`, or `error` before exit.
- Do not use SMB mail-thread state.
