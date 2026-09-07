---
name: github
description: GitHub E2E repo discovery, secret scan, remediation report, and recheck pipeline.
domain: github
when_to_use: GitHub E2E pipeline work, repo secret exposure reporting, or remediation recheck.
triggers: github; 깃헙; 깃허브; repo; 레포; 소스코드; github e2e; github report; github recheck
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# GitHub E2E Pipeline

GitHub E2E is a domain pipeline in `secu-agent-skill`. It is not mounted into
the SMB 8767 web service and it does not modify the `secu-agent` engine.

Runtime entrypoints:

- Web/API service: `python -m domains.services.github.webapp.app`
- Persistent runner: `python -m domains.services.github.runners.pipeline`
- One-shot agents:
  - `python -m service.agents.github_discovery_agent`
  - `python -m service.agents.github_scan_agent`
  - 검토원 서브프로세스는 엔진(`python -m secu_agent.agent <evidence_dir>`)이다.
    (평면 SSO 레인의 `service.agents.github_task_worker` 진입점은 2026-08-28 은퇴)
  - `python -m service.agents.github_report_agent`
  - `python -m service.agents.github_recheck_agent`

Core reattachment is through `SA_PLUGINS=$PWD/plugin/bootstrap.py` and, for
fanout plans, `SA_SKILLS_DIRS=$PWD/domains/services/github/skills`.

## Pipeline

1. Discovery enumerates repositories visible to the configured GitHub token and
   upserts the bounded rolling queue `github_repo_target`.
2. SSO URL discovery searches proxy logs for `github.samsungds.net` URLs,
   normalizes them to repo-level `devops_target(service='github')` rows, and
   keeps that URL lane isolated from Confluence.
3. Scan claims one or more `github_repo_target` rows, searches first with
   GitHub APIs (`code_search` plus recent commit patch APIs), fetches file or
   patch details only for selected candidates, masks all secret material, and
   upserts lifecycle findings with `task_type='github'`. Clone/worktree
   scanning is only a bounded fallback when API access is unavailable.
4. SSO task claims `devops_target(service='github')` rows, starts with
   `web_site_sweep`, and for repo URLs uses
   `github_task_scan(repos=[...])` so hot-path enumeration selects
   candidates before detailed file/commit inspection. For blob/raw/blame URLs,
   pass visible `ref` plus exact `file_paths=[...]` and disable broad fallback
   so only that file content API detail is inspected first; preserve visible
   `/refs/heads/<branch>` and `/refs/tags/<tag>` refs as full refs. For tree URLs, pass
   visible `ref` plus exact `directory_paths=[...]` and disable broad fallback
   so only blobs below that visible directory are listed and fetched by API;
   root tree URLs (`/tree/<ref>`) use `directory_paths=["."]` for bounded
   root-tree detail fetches instead of broad repo scanning. For archive URLs,
   pass the visible archive ref plus `directory_paths=["."]` so the archive
   snapshot's root tree is listed and fetched by API without broad fallback. For
   PR URLs, pass the visible `/pull/<number>` as `pull_numbers=[...]` so the PR
   files API is inspected directly without broad recent-commit or hot-path
   fallback. For PR list URLs, pass `include_pull_requests=True` so a bounded
   PR list is enumerated and only PR files patch details are inspected. For
   issue URLs, pass the visible `/issues/<number>` as
   `issue_numbers=[...]` so the issue body/comments API is inspected directly
   without broad recent-commit or hot-path fallback. For issue list URLs, pass
   `include_issues=True` so a bounded issue list is enumerated and only issue
   body/comment details are inspected. For compare URLs, pass the
   visible `/compare/<base>...<head>` as `compare_refs=[...]` so the compare
   files API is inspected directly. For release download URLs, pass the visible
   `/releases/download/<tag>/<asset>` tag as `release_tags=[...]` so release
   note and asset metadata details are inspected directly. For release list
   URLs, pass `include_releases=True` so bounded release notes and asset metadata
   are inspected directly without broad code search or recent commit fallback.
   For GitHub code search URLs, pass the visible
   `q=` terms into API search after
   stripping `repo:` qualifiers; only a single global `repo:<owner>/<repo>`
   qualifier may recover missing repo scope, a single global `org:<ORG>` or
   `user:<OWNER>` plus concrete search terms may drive bounded owner-scope API
   search, and path repo scope wins over query qualifiers.
5. Report builds repo-scoped JSON/HTML remediation reports from
   `github_report_thread`, grouped by repository, path, source, verification
   state, and severity.
6. Recheck prefers read-only API HEAD detail refetch for original finding
   paths, falls back to clone/current-HEAD inspection only when needed,
   compares the original masked signatures, writes `github_recheck_result`,
   and transitions findings to `remediated` only when the original signature is
   absent from inspectable current HEAD content.
7. POP3 inbound replies to `[GitHub 보안취약점 조치요청](repo)` are audited in
   `service_reply_message`; only new reply text before `Original Message` is
   classified. Remediation claims move the repo thread to `recheck_requested`,
   while owner change, not-owner, business exception, or unclear replies stay
   out of the recheck queue and transition to the matching review/waiting state.
   How-to replies stay `awaiting_owner` but `github_recheck` sends one
   reply-style guidance mail, quotes the original message, records
   `outbound_how_to_guidance`, and suppresses duplicate guidance for the same
   inbound reply. If POP3 collected the reply before the report thread was
   marked as awaiting owner, a successful report delivery re-attaches recent
   unmatched replies by subject tag.

## State Model

- `github_repo_target`: rolling repository queue, oldest-first with cooldown.
  Each weekly board cycle resets per-repo `cycle_scanned_at` progress so the
  scan stage starts from a fresh repo queue without deleting historical
  findings, report threads, or prior scan timestamps.
- `devops_target(service='github')`: proxy-log SSO URL queue. Each weekly board
  cycle resets only GitHub URL `cycle_scanned_at` progress so SSO task starts
  fresh without perturbing Confluence URL rows.
- `github_report_thread`: repo-scoped remediation/report state.
  Unknown technical recheck results stay `recheck_requested` with `retry_after`
  scheduled (default 8 hours) instead of being reclaimed immediately.
  How-to guidance dry-runs or delivery failures keep the thread
  `awaiting_owner` with the same retry cooldown instead of re-claiming
  immediately. Recheck and how-to guidance retries are bounded by the runtime
  `attempt_count` cap; cap-exceeded threads are escalated instead of rechecked
  or mailed again.
- `github_recheck_result`: immutable remediation check audit rows.
- `service_reply_message`: inbound/outbound remediation mail audit for
  GitHub/Confluence report threads, including classified reply verdict,
  decision reason, and extracted owner hints when present.

Do not use SMB IP/share/mail-thread state for GitHub report or recheck work.

## Finding Contract

Persist GitHub findings only after API search candidates are confirmed by
detail refetch, exact file/directory/commit/PR/issue/compare/release details
are scanned, recent commit patch details are scanned, or bounded fallback clone
evidence exists.

- `task_type`: `github`
- `asset_kind`: `repository_file` for HEAD findings, `commit_patch` for history
  or PR/compare findings, `issue` for issue body/comment findings, and
  `release` for release note/asset metadata findings
- Evidence: masked snippet, repo/path/line, scan method, source (`worktree` or
  `history`), optional commit SHA, and verification status
- Verification status:
  - `live_in_HEAD`: current HEAD still contains the signature
  - `historical_only`: detected only in git history

Never persist plaintext tokens, credentials, or full file contents.

## Reporting

GitHub reports are optimized for source remediation, not SMB share remediation.
They should call out:

- repo and path
- whether the secret is still live in HEAD or only in history
- masked credential kind/value
- recommended actions: rotate credentials, remove from HEAD, clean or restrict
  history, check sibling repos and CI reuse

The report HTML follows the DSSOC remediation format used by SMB E2E: header,
summary metric cards, action guidance, masked evidence table, and a footer. It
must stay source/repo oriented and must not copy SMB IP/share terminology.

Report thread statuses include `partially_remediated`, `exception_review`,
`owner_update_needed`, `owner_reassignment_review`, and `reassigned` so GitHub
can represent the same HITL/partial-remediation states as SMB while keeping
state in `github_report_thread`.

## Skills

The fanout worker contracts live under `domains/services/github/skills/`:

- `github_scan`: scan the claimed repository and release the repo claim
- `github_task`: handle one proxy-discovered GitHub SSO URL and release the
  `devops_target` claim
- `github_report`: build and persist a repo-centered remediation report
- `github_recheck`: verify remediation and record structured recheck results

## Safety

- Read-only GitHub access only.
- No destructive git or GitHub operation.
- No active credential validation beyond configured read access.
- Mask secrets before evidence, findings, reports, logs, or delivery.
- Treat keyword or filename hits without secret evidence as insufficient.
