# Domain parity plan: SMB -> GitHub / Confluence

This document tracks the current SMB reference capability against GitHub and
Confluence. The target end state is not "same code"; it is the same operational
shape: bounded target discovery, cheap candidate search, precise detail fetch,
evidence-backed findings, report/mail, reply/recheck, HITL states, dashboard
counts, and adversarial tests.

## Reference slices

| Slice | SMB reference | GitHub current | Confluence current | Gap to close |
| --- | --- | --- | --- | --- |
| Target discovery | `smb_target_subnet` queue, weekly reset, subnet sweep | `run_github_repo_discovery`, `github_repo_target` rolling queue with weekly fresh-cycle reset; GitHub SSO `devops_target(service='github')` URL lane also resets and reports by current cycle without resetting Confluence rows | `run_confluence_space_discovery`, `confluence_space_target` rolling queue with weekly fresh-cycle reset; Confluence SSO `devops_target` URL lane also resets and reports by current cycle without resetting GitHub rows; SSO workers keep `tasked`/`skipped`/`error` terminal paths in prompt and skill contracts | Keep discovery tests service-filtered so GitHub and Confluence URL lanes cannot consume each other. |
| Cheap search phase | Subnet/host/share enumeration before deep walking | Repo queue scanner and `github_task_scan` use API-first code search, exact file path candidates, exact directory tree candidates, exact commit SHA candidates, exact PR number candidates, exact issue number candidates, exact compare range candidates, and recent commit patch scan before bounded hot-path fallback; SSO URL workers extract explicit `owner/repo` hints even from deep repo URLs and pin the exact `github_task_scan(..., api_search_first=True)` call before browser deep-dive; malformed repo targets or search candidates without repo/path/file/directory/commit/PR/issue/compare scope fail closed; duplicate explicit or org-enumerated repo targets are deduped before metadata/API search with audit counts; explicit repo metadata 403/404 plus code-search, hot-path, file, directory, commit, PR, issue, and compare API 403/404s that repo metadata confirms as deleted/inaccessible now recommend `skipped` before retry/fallback churn; API search/detail/fallback/exact-scope failures preserve structured HTTP status codes for audit; worker contract now pins search/candidate/detail errors as no broad clone fallback | Space batch uses CQL/API candidate search before detail fetch; malformed space targets and page candidates without IDs or expected space scope fail closed; duplicate explicit or all-space-enumerated space targets are deduped before CQL search with audit counts; status-code-backed deleted/inaccessible CQL or fallback list targets now recommend `skipped` without retry/fallback churn; worker contract is pinned to no `list_pages` fallback on CQL/API search failure | Keep worker contracts/tests aligned as new search/detail failure modes are added. |
| Detail phase | Walk share, inspect files/images/PDFs only when needed | API-selected file candidates are fetched by path/default ref, exact SSO blob/raw/blame file URLs fetch only that file content detail, exact SSO tree URLs list only the visible directory and fetch blob details below that path, exact SSO commit URL SHAs fetch only that commit patch detail, exact SSO PR URLs fetch only that PR files detail, exact SSO issue URLs fetch only that issue body/comment detail, exact SSO compare URLs fetch only that compare files detail, and recent commit patches are scanned before persistence; explicit repos resolve metadata before detail fetch; bounded fallback, file/blob detail, exact file detail, exact directory detail, commit patch detail, PR file detail, issue body/comment detail, and compare file detail fetches all record missing responses, empty bodies, malformed candidates, duplicate explicit paths, and structured detail errors; stale commit-patch hits are HEAD rechecked as historical-only and keep the commit cursor even for explicit repo scans | CQL-selected pages/comments/versions/text attachments are fetched and scanned before persistence; direct comment URLs fetch only the exact comment body by API before browser deep-dive; direct attachment download URLs list the parent page attachments and fetch only the exact matching attachment body before browser deep-dive; bounded fallback page, comment, version, and attachment detail fetches plus missing responses, empty page/comment/version/attachment bodies, malformed comment/attachment/page-version candidates, and unexpected page/detail subresource processing failures are counted in detail/error metrics with structured HTTP status codes; status-code-backed explicit page detail 403/404 recommends `skipped` instead of retrying deleted/inaccessible page targets; historical-version hits are compared with current page signatures and marked current-page or historical-version before persistence | Continue adding adversarial checks for missing/denied/stale detail responses. |
| Owner routing | Splunk owner lookup, pending/processing/done counts | Owner recipients are preserved from internal GitHub author metadata; report sync returns `owner_recipient_count`/`owner_missing_count` so owner routing gaps are visible before worker claim; default delivery remains DSSOC-only unless production mode is explicitly enabled; owner-missing rows appear in the owner stage and stay out of report queue/claim counts until `owner_recipient` is populated; operator reassignment can fill an ownerless current-cycle `reported` thread and requeue it for reporting | Owner recipients are preserved from internal Confluence metadata; report sync returns `owner_recipient_count`/`owner_missing_count` so owner routing gaps are visible before worker claim; default delivery remains DSSOC-only unless production mode is explicitly enabled; owner-missing rows appear in the owner stage and stay out of report queue/claim counts until `owner_recipient` is populated; operator reassignment can fill an ownerless current-cycle `reported` thread and requeue it for reporting | Keep enriching owner reassignment audit and operator evidence, but base recipient safety parity is implemented. |
| Finding lifecycle | Submit finding, merge by host/share, recurrence | Finding lifecycle and repo report thread support weekly recurrence, report-thread status/recheck-result transitions, cycle-scoped report/reply/recheck views, and W25 backfill for pre-cycle report rows | Finding lifecycle and space report thread support weekly recurrence, report-thread status/recheck-result transitions, cycle-scoped report/reply/recheck views, and W25 backfill for pre-cycle report rows | Continue checking cross-cycle edge cases when adding new report states. |
| Report/mail | HTML remediation report, dry-run rules, outbound audit | Report worker/HTML exists with cycle-scoped report UI/API views; sent report delivery records `outbound_report_notice` with subject tag, sender/recipient, and HTML body in the message timeline; dry-run remains `report_ready` with no sent-mail audit by design; `reported` threads without `owner_recipient` are not claimable by report workers; report passes sync unthreaded current findings before claiming so fresh findings are not missed | Report worker/HTML exists with cycle-scoped report UI/API views; sent report delivery records `outbound_report_notice` with subject tag, sender/recipient, and HTML body in the message timeline; dry-run remains `report_ready` with no sent-mail audit by design; `reported` threads without `owner_recipient` are not claimable by report workers; report passes sync unthreaded current findings before claiming so fresh findings are not missed | Keep matching recipient safety, report thread views, and dry-run semantics as new states are added. |
| Reply intake | POP3 passive collector, thread correlation, HTML/CID quote handling, how-to replies | POP3 replies are correlated into `service_reply_message` and report threads, including HITL/owner/escalated statuses that may receive follow-up owner responses; stale unmatched replies before report delivery are not attached; how-to replies are handled by `github_recheck` as reply-style guidance mail with original-message quote, threading IDs, and duplicate suppression; duplicate POP3 replies backfill CID-safe HTML for quote rendering; outbound report/recheck/how-to timeline rows preserve their HTML bodies and render them in sandboxed dashboard frames; service-domain POP3 smoke routing can exercise GitHub threads with unique non-remediation subjects without weakening production subject matching | POP3 replies are correlated into `service_reply_message` and report threads, including HITL/owner/escalated statuses that may receive follow-up owner responses; stale unmatched replies before report delivery are not attached; how-to replies are handled by `confluence_recheck` as reply-style guidance mail with original-message quote, threading IDs, and duplicate suppression; duplicate POP3 replies backfill CID-safe HTML for quote rendering; outbound report/recheck/how-to timeline rows preserve their HTML bodies and render them in sandboxed dashboard frames; service-domain POP3 smoke routing can exercise Confluence threads with unique non-remediation subjects without weakening production subject matching | Keep stale-cycle and rich quote rendering covered across domains. |
| Recheck | Reply-driven reverify and status transitions | Reply decisions route to recheck/HITL; `github_recheck` finalizes after delivery and records outbound report/recheck/how-to notice kinds in the message timeline; recheck-result mail only quotes inbound replies newer than the latest sent outbound; unknown rechecks and recheck-result or how-to delivery dry-run/failures remain queued with an 8h retry cooldown; recheck and how-to guidance attempts are current-cycle guarded, capped, and escalated before infinite retry; HTTP refetch failures preserve status codes in recheck verification evidence | Reply decisions route to recheck/HITL; `confluence_recheck` finalizes after delivery and records outbound report/recheck/how-to notice kinds in the message timeline; recheck-result mail only quotes inbound replies newer than the latest sent outbound; unknown rechecks and recheck-result or how-to delivery dry-run/failures remain queued with an 8h retry cooldown; recheck and how-to guidance attempts are current-cycle guarded, capped, and escalated before infinite retry; HTTP refetch failures preserve status codes in recheck verification evidence | Continue matching retry/communication failure semantics as new failure modes appear. |
| HITL states | Business exception, not owner, owner changed, reassignment review | Classifier reasons/owner hints persist and appear in dashboard/detail; standalone webapp can reassign owners, while exception approval/rejection is scoped to `exception_review`; operator HITL actions are current-cycle guarded and audited in the thread message timeline with structured before/after evidence snapshots | Classifier reasons/owner hints persist and appear in dashboard/detail; standalone webapp can reassign owners, while exception approval/rejection is scoped to `exception_review`; operator HITL actions are current-cycle guarded and audited in the thread message timeline with structured before/after evidence snapshots | Continue matching richer approval workflows as HITL states are expanded. |
| Dashboard | Stage counts, targets, active/next, cycle filters | Standalone app/projection has report/reply/recheck cycle views, report UI cycle filters, and stuck claim visibility/reset controls for scan, SSO URL task, report, and recheck, including `awaiting_owner` how-to guidance claims and escalated owner-missing visibility; reset controls are current-cycle guarded and report/recheck thread resets write structured operator audit messages; manual recheck and HITL actions expose current-cycle/status capability flags; standalone report APIs stay unmounted from the SMB webapp | Standalone app/projection has report/reply/recheck cycle views, report UI cycle filters, and stuck claim visibility/reset controls for space/API, SSO, report, and recheck, including `awaiting_owner` how-to guidance claims and escalated owner-missing visibility; reset controls are current-cycle guarded and report/recheck thread resets write structured operator audit messages; manual recheck and HITL actions expose current-cycle/status capability flags; standalone report APIs stay unmounted from the SMB webapp | Continue enriching owner lookup workflow parity. |
| Adversarial tests | Stale thread, stale replies, dry-run blocks, CID quote, weekly recurrence | API-first false-positive terminal no-report, malformed blank/enum repo target/code-search repo/path/hot-path blob/commit-patch candidate, duplicate explicit and org-enumerated repo target dedup before metadata/API search, stale commit-patch HEAD recheck/cursor preservation, repo enum/code-search HTTP/rate-limit failure fail-closed with HTTP status audit, queue scanner HEAD/ref 404 metadata check, explicit repo metadata 403/404 skipped before search, ref-scoped missing/inaccessible repo API 403/404 skipped before fallback/commit work, commit API missing-repo 404 skipped without cursor advancement, bounded candidate detail fetch, bounded no-candidate/API-unavailable hot-path fallback, fallback listing HTTP/ref error, fallback missing-detail/fallback detail error, unexpected repo detail processing error, recent commit patch/detail error with HTTP status audit, empty file/blob/commit patch detail, duplicate code-search candidate dedup/audit, missing detail, search error, and detail error are covered in queue scanner and `github_task_scan`; service-filtered SSO discovery/fanout/cycle reset, stale/wrong-session stuck claim reset including how-to guidance claims and structured operator audit for thread resets, old-cycle stuck claim reset rejection, manual recheck stale-cycle/terminal/pre-report guards, HITL old-cycle reassign/exception guards, escalated owner-stage visibility, stale report rebuild, W25 legacy report/mail backfill, recurrence, reply, stale unmatched reply attach guard, stale recheck-result quote guard, delivery policy, report/pass dry-run no-send/no-audit, outbound report notice audit fields, retry-cooldown delivery/pass failure, current-cycle how-to guidance claim guard, how-to reply dedup/quote guidance, forwarded/nested RE subject normalization, dry-run retry, exception/owner HITL separation, and structured HITL evidence tests exist | API-first false-positive terminal no-report, malformed/duplicate explicit and all-spaces-enumerated space target, explicit page not found skipped, status-code-backed explicit page detail 403/404 skipped, malformed CQL ID/scope/attachment/page-version candidate, historical version current-page signature present/absent checks, bounded CQL candidate detail fetch, space enum/CQL/listing HTTP failure fail-closed, status-code-backed space CQL 403/404 skipped without `list_pages` fallback, status-code-backed fallback list_pages 403/404 skipped, status-code-backed comment/history/attachment detail subresource errors, structured CQL/fallback listing failure, CQL candidate detail-missing error, fallback missing-detail, missing detail, empty page/comment/attachment/history detail, page/comment/attachment/history detail HTTP failure, unexpected page/detail subresource processing failure, service-filtered SSO discovery/fanout/cycle reset, stale/wrong-session stuck claim reset including how-to guidance claims and structured operator audit for thread resets, old-cycle stuck claim reset rejection, manual recheck stale-cycle/terminal/pre-report guards, HITL old-cycle reassign/exception guards, escalated owner-stage visibility, stale report rebuild, W25 legacy report/mail backfill, search failure/no full-list fallback, duplicate CQL candidate dedup/audit, recurrence, reply, stale unmatched reply attach guard, stale recheck-result quote guard, delivery policy, report/pass dry-run no-send/no-audit, outbound report notice audit fields, retry-cooldown delivery/pass failure, current-cycle how-to guidance claim guard, how-to reply dedup/quote guidance, forwarded/nested RE subject normalization, dry-run retry, exception/owner HITL separation, and structured HITL evidence tests exist | Continue extending HITL evidence tests as new states are introduced. |

## First implementation lane

1. Keep SMB as the executable reference and fix reference bugs immediately.
2. GitHub: make repo scan workers do API-first candidate search, then detail
   fetch only matched paths/commits.
3. Confluence: make space workers do API/CQL candidate search, then detail fetch
   pages/comments/attachments that match candidate rules.
4. For each lane, add adversarial checks: inaccessible target, stale current
   state, false positive marker, duplicate recurrence, and stale reply/thread.

## Incremental parity notes

- API authentication failures are fail-closed. GitHub scan/recheck API 401 and
  Confluence scan/recheck API 401 preserve `auth_failed=true` in stored and
  rendered evidence, and stop fallback/detail continuation instead of trying a
  broader scan path.
- GitHub API rate-limit/abuse-limit failures are also fail-closed. Queue scan
  and `github_task_scan` preserve `limit_failed=true` plus HTTP status evidence
  and do not retry as repo-missing metadata checks, hot-path tree fallback, or
  clone fallback.
- Confluence API rate-limit/abuse-limit failures are fail-closed for CQL search,
  page listing, and page/detail fetch. `confluence_task_scan` preserves
  `limit_failed=true` plus HTTP status evidence, keeps 403 rate-limit separate
  from deleted/inaccessible `skipped` targets, and stops list/detail fallback
  expansion.
- GitHub and Confluence recheck refetch rate-limit/abuse-limit failures remain
  retryable `unknown` results and preserve `limit_failed=true` plus HTTP status
  evidence in per-finding verification payloads and rendered recheck evidence,
  instead of looking like a clean remediation or a generic access denial. Both
  standalone dashboards now render `auth_failed` and `limit_failed` in the
  recheck trace/evidence table so operators can distinguish credential problems
  from throttling without opening raw JSON.
- GitHub recheck now writes a `github_recheck_evidence` JSON bundle like
  Confluence recheck, preserving the pre-delivery final status, per-finding
  verification rows, API/clone scan metadata, and auth/rate-limit flags under
  an `evidence_ref` returned to the agent workflow. Global clone fallback
  failures are represented as retryable `unknown` results in both DB rows and
  the evidence bundle, not as an empty result set.
- Confluence recheck evidence filenames now sanitize `space_key` values before
  writing under the supplied evidence directory, mirroring the GitHub evidence
  path guard for malformed or operator-injected target identifiers.
- GitHub agent evidence directories now route to `SA_GITHUB_EVIDENCE_DIR`
  instead of falling through to the SMB evidence root, so scan/recheck/guidance
  traces stay separated by domain while retaining the same sanitized
  single-component label behavior.
- Confluence fanout workers now use the same shared evidence directory factory
  as SMB, GitHub, and dev_web, preserving `SA_CONFLUENCE_EVIDENCE_DIR` plus
  `SA_E2E_EVIDENCE_DIR` fallback and the same sanitized label contract.
- Confluence SSO search URLs preserve visible query intent as API-first CQL
  candidate selection for both `text ~` and `title ~`, including
  `searchQuery.queryString` plus `searchQuery.spaceKey` namespace parameters.
- GitHub worker skill contracts are now part of the default agent runtime
  search path, matching SMB, dev_web, and Confluence. Direct GitHub worker or
  agent runs no longer depend on fanout-only `SA_SKILLS_DIRS` injection to load
  `github_task`, `github_scan`, `github_report`, or `github_recheck`.
- GitHub scan/report/recheck and Confluence report/recheck fanout workers now
  write core schema-compliant `worker_result.json` files like SMB workers.
  Retryable `recheck_requested`, delivery dry-run/failure, skipped reports, and
  inaccessible targets are preserved as completed worker passes instead of
  being misread by fanout as subprocess crashes that overwrite domain retry
  state.
- Adversarial fanout tests now pass those service-domain worker results through
  the core `_completion_ok` path, proving skipped/retryable/dry-run worker
  outcomes are accepted as completed fanout work rather than inferred from the
  local reader alone.
- GitHub and Confluence report/recheck fanout specs now carry `charter_ref`
  through to their worker `_handle_thread` calls, matching SMB report/reply
  workers so remediation delivery and recheck evidence keep the same authorized
  tasking context in subprocess fanout mode.
- GitHub API-first repo scan specs and worker entrypoints now propagate
  `charter_ref` into `github_e2e_scan_evidence`, so deterministic search/detail
  tasking evidence carries the same authorized context as SMB task workers.
- Confluence space/SSO task specs and `confluence_task_scan` evidence now keep
  `charter_ref` through API/CQL candidate search, detail fetch, and malformed
  candidate error paths, matching the GitHub/SMB authorized-evidence contract.
- GitHub `github_task_scan` service-task evidence now also keeps
  `charter_ref` from `ToolContext.metadata` through exact commit search,
  malformed commit-scope failures, finding persistence, and the returned tool
  payload, closing the last API-search service-task gap against SMB workers.
- GitHub and Confluence recheck evidence bundles now preserve `charter_ref`
  from recheck workers through retryable/unknown and sanitized target evidence
  paths, so remediation verification JSON carries the same authorized context
  as SMB reply/reverify evidence.
- GitHub and Confluence SSO fanout failure reset paths now guard by
  `devops_target.service`, so a forged or stale worker release cannot reset the
  other service's URL lane; adversarial gateway tests cover both directions.
- `devops_target_upsert` now preserves the existing row's service owner when a
  duplicate URL/day arrives with a different service, preventing discovery
  drift from stealing, resetting, or reclocking another SSO lane across cycles.
- GitHub repo-scan clone fallback remains bounded to API-unavailable cases, but
  now records `clone_fallback.reason=api_unavailable` plus the triggering API
  errors in scan evidence so operators can distinguish an outage fallback from
  normal API-selected candidate/detail scanning.
- Confluence no-candidate CQL fallback now records structured `list_pages`
  fallback attempts with space, reason, returned/added counts, candidate-limit
  markers, and error/status flags, so bounded fallback is auditable like the
  GitHub API fallback path.
- GitHub `github_task_scan` hot-path fallback now records structured fallback
  attempts with repo, ref, reason, returned/selected counts, candidate-limit
  markers, and listing error/status flags, matching Confluence fallback
  auditability while keeping API-search failures fail-closed.
- GitHub and Confluence service-task evidence files now persist the same
  `api_search` audit metadata returned in tool payloads, including fallback
  attempts, search/detail counters, and fail-closed flags, so `evidence_ref`
  alone can reconstruct the API-search-to-detail path.
- Service-task evidence now also persists the final `scan_status`,
  `recommended_target_status`, and `status_reason` for GitHub and Confluence,
  so the saved evidence bundle carries the same terminal disposition as the
  returned worker payload.
- GitHub and Confluence service-task evidence now persists final target counts
  and target identifiers alongside API-search audit metadata, so operators can
  reconstruct which repos or pages reached the detail phase from `evidence_ref`
  without relying on the transient tool response.
- GitHub and Confluence pipeline projections now count escalated report threads
  as reply-seen, matching SMB's reply intake semantics while keeping escalated
  rows out of recheck queues.
- Service-task evidence target audit now also records GitHub refs/default
  branches/source lanes and Confluence page space/title/candidate source
  details, so `evidence_ref` preserves the precise target context used for
  detail scans. Malformed GitHub repo and Confluence space target candidates
  are also preserved in `target_details` with `status=error`; explicit GitHub
  repo metadata failures and Confluence space page-listing failures now do the
  same, as do GitHub org repository enumeration and Confluence all-spaces
  enumeration failures, matching SMB's target-level failure audit posture.
- Target-stage audit is now summarized in `api_search` with
  `target_status_counts`, `target_source_counts`, and
  `target_status_by_source`, so selected targets and target-candidate failures
  are visible from the returned payload and persisted evidence without opening
  every `target_details` row.
- Detail content scan outcomes are now summarized in `api_search.scan_summary`
  with content artifact counts, source-by-source detector hit counts,
  reportable artifact counts, and low-value-only suppression counts, so the
  API-search-to-detail path shows which candidate lane actually produced
  actionable evidence before opening every artifact row.
- Persisted finding lifecycle outcomes are now summarized in
  `api_search.finding_summary` with created/existing counts, status/source
  breakdowns, report-update decisions, and follow-up signal decisions, making
  false-positive/accepted-risk suppression auditable from the same scan
  evidence as active finding creation.
- GitHub code-search and Confluence CQL search phases now preserve per-query
  `query_details` with status, returned/added counts, skipped breakdown
  (`invalid`, `out_of_scope`, `duplicate`), and structured error fields, so the
  API-first search stage can be audited independently from the later
  detail-fetch stage. The same search stage now also exposes aggregate
  `query_status_counts` and `query_candidate_totals` so operators can see
  searched/error query counts plus raw returned/added/skipped candidate totals
  before opening individual query rows.
- GitHub hot-path and Confluence page-list fallback attempts now also record
  candidate skip breakdowns (`invalid`, `out_of_scope`, `duplicate`,
  `limit_skipped`, `skipped`) alongside returned/selected/added counts. Fallback
  attempts also expose `fallback_status_counts`, `fallback_reason_counts`, and
  `fallback_candidate_totals` so fallback stage health and candidate movement
  are visible without opening every fallback attempt row.
- GitHub and Confluence service-task `api_search` metadata now summarizes
  detail evidence statuses with `detail_status_counts` and
  `detail_status_total`, and splits them by detail surface in
  `detail_status_by_kind` (`file`/`commit` or
  `page`/`comment`/`version`/`attachment`), so fetched/missing/error detail
  outcomes are visible without opening every per-file or per-page evidence
  list.
- GitHub commit-list and release-list API scans now record structured
  `commit_list_attempts` and `release_list_attempts` with returned/selected/
  skipped/error counts and status codes, matching the PR/issue/branch/tag list
  audit shape and making list-stage failures visible from both tool payloads
  and persisted evidence.
- GitHub PR-list and issue-list scope handling now gates list candidates before
  detail fetch: out-of-scope PRs/issues are skipped, counted in
  `out_of_scope`/`skipped`, preserved in their detail evidence, and do not
  inflate selected detail counts.
- GitHub release-list failure handling is now adversarially covered: a failed
  `list_releases` call records the `release_list_attempts` and
  `release_details` error evidence without broad code search, hot-path
  fallback, commit scans, or release-detail fetches.
- GitHub release-list scope handling now mirrors other bounded API candidate
  lanes: out-of-scope releases are skipped before detail scan, counted in
  `out_of_scope`/`skipped`, preserved in `release_details`, and do not inflate
  selected release counts.
- GitHub commit-list failure handling is now adversarially covered as well: a
  failed bounded commit-list call records `commit_list_attempts` and
  `commit_details` error evidence without broad code search, hot-path fallback,
  or unrelated explicit commit-detail fetches.
- GitHub commit-list scans now dedupe repeated commit SHAs before detail
  scanning and record duplicate skip counts in `commit_list_attempts`, so the
  returned candidate count and selected unique detail count remain auditable.
- GitHub commit-list scope handling now preserves out-of-scope skipped commit
  candidates in `commit_details`, counts them in `out_of_scope`/`skipped`, and
  keeps them out of selected commit detail scans and findings.
- GitHub PR-list and issue-list failure handling now have the same coverage:
  failed `list_pull_requests` or `list_issues` calls preserve attempt/detail
  error evidence and do not open broad search, hot-path fallback, commit scans,
  or PR/issue detail fetches.
- GitHub PR-list detail fetch failures are now adversarially covered as well:
  when `list_pull_requests` succeeds but `fetch_pull_request_files` fails, the
  scan records `pull_request_details`, attempt skip counts, query/source/status
  breakdowns, and HTTP status without broad search, fallback, or commit scans.
- GitHub issue-list detail fetch failures now have matching coverage: when
  `list_issues` succeeds but `fetch_issue_detail` fails, the scan records
  `issue_details`, attempt skip counts, query/source/status breakdowns, and
  HTTP status without broad search, fallback tree scans, or commit scans.
- GitHub branch-list detail listing failures are now adversarially covered:
  when `list_branches` succeeds but branch-scoped hot-path listing fails, the
  scan records `branch_details` and `detail_error_summary` with branch, query,
  source, and HTTP status without broad code search, fallback tree scans, or
  blob fetches.
- GitHub branch-list blob detail fetch failures now match that coverage: when
  the branch list and bounded hot-path listing succeed but `fetch_blob_text`
  fails, the scan preserves `branch_details`, errored `file_details`, and HTTP
  status without broad code search, fallback tree scans, or commit scans.
- GitHub branch-list blob scope skips are now adversarially covered: blobs
  returned from a branch-scoped hot-path listing but belonging to another repo
  are preserved as skipped `file_details`, counted in `out_of_scope`/`skipped`,
  and never fetched.
- GitHub tag-list detail listing failures now have matching coverage: when
  `list_tags` succeeds but commit-scoped hot-path listing fails, the scan keeps
  `tag_details`, query/source/status breakdowns, and HTTP status evidence
  without broad code search, fallback tree scans, or blob fetches.
- GitHub tag-list blob detail fetch failures are covered the same way: after
  bounded tag hot-path candidates are selected, failed `fetch_blob_text` calls
  preserve `tag_details`, errored `file_details`, and HTTP status without broad
  code search, fallback tree scans, or commit scans.
- GitHub tag-list blob scope skips now mirror branch-list coverage: out-of-scope
  blobs from commit-scoped hot-path listings are retained as skipped
  `file_details`, counted in `out_of_scope`/`skipped`, and excluded from blob
  fetches and findings.
- Confluence attachment-list scans now also record failed `list_attachments`
  calls in `attachment_list_attempts` with returned/selected counts and status
  codes, so page-scoped attachment-list URLs keep list-stage failure evidence
  even when no attachment detail can be fetched. When bounded text attachment
  selection hits `max_attachments_per_page`, both the per-attempt record and
  top-level API search metadata now mark `candidate_limit_hit`, and the
  per-attempt record preserves skipped text-attachment counts; candidates beyond
  that bound are not fetched.
- Confluence attachment-list detail fetch failures are adversarially covered:
  after bounded text attachments are selected, failed `fetch_attachment_text`
  calls preserve `attachment_list_attempts`, errored `attachment_details`,
  `detail_error_summary`, and HTTP status without CQL, page-list, page-body,
  comment, history, or unrelated attachment broadening. Partial fetch failures
  on one selected attachment continue scanning remaining selected text
  attachments and preserve both errored and fetched detail rows.
- Confluence attachment parent-scope skips are now preserved as skipped
  `attachment_details`: attachments returned from page detail and page-scoped
  attachment-list scans but owned by another page are counted in
  `out_of_scope`, kept out of attachment body fetches and findings, and remain
  visible in source/status summaries.
- Confluence CQL and page-list page scope skips now preserve skipped
  `page_details`: out-of-space page candidates are counted in
  `out_of_scope`/`skipped`, kept out of body fetches and findings, and remain
  visible in source/status summaries for both CQL and bounded `list_pages`
  fallback lanes.
- Confluence blogpost-list scans now have the same adversarial no-broadening
  coverage: failed `list_blogposts` calls stay in `blogpost_list_attempts` and
  target audit evidence with HTTP status codes, without falling back to CQL,
  normal page lists, or detail fetches.
- Confluence explicit page-list scans now have matching no-broadening coverage:
  failed `list_pages` calls for `include_pages=True` stay in
  `page_list_attempts` and target audit evidence with HTTP status codes,
  without falling back to CQL, blogpost lists, or detail subresource fetches.
- Detail API failures are also summarized in `detail_error_summary` with total
  count plus phase, candidate source, candidate query, and status-code
  breakdowns, so operators can see whether detail failures came from a specific
  API search lane, bounded fallback lane, path/blob/page/attachment fetch, or
  API throttling without opening raw error arrays.
- Detail evidence is also summarized by candidate source in
  `detail_source_counts` and `detail_status_by_source`, preserving whether
  detail work came from API search (`code_search`/`space_cql`) or bounded
  fallback (`hot_path_tree`/`space_list`) without inspecting each detail row.
- Detail evidence is additionally summarized by candidate query in
  `detail_query_counts` and `detail_status_by_query`, preserving the
  search-query-to-detail-fetch lane for API-first scans while grouping bounded
  fallback rows under `(no query)`.
- GitHub service-task target details now include valid deduplicated exact
  `commit_shas` when the scan is constrained to explicit commit patch detail,
  while malformed exact commit SHA and recent commit identity candidates also
  appear in `commit_details` with `status=error`.
- Confluence service-task evidence now records validated text attachment detail
  targets with page id, space, title, attachment id, filename, download URL, and
  candidate source/query, so attachment fetches are auditable without digging
  through artifact metadata.
- Confluence service-task evidence now also records comment and historical page
  version detail targets with page context and candidate source/query, making
  comment/history subresource fetches auditable even when a version fetch fails
  or later proves clean.
- Confluence exact comment detail fetch failures are now adversarially covered:
  a failed `fetch_comment_detail` call records comment detail/error evidence and
  HTTP status without broadening into CQL, page listing, page body, history, or
  attachment scans.
- Confluence exact page-version detail fetch failures are now covered the same
  way: failed `fetch_page_body_version` calls keep version detail/error evidence
  and HTTP status without broadening into current page, comment, history, or
  attachment scans.
- Confluence exact attachment list failures are now covered as well: a failed
  parent-page `list_attachments` call keeps attachment detail/error evidence and
  HTTP status without broadening into page body, comment, history, version, or
  unrelated attachment fetches.
- Confluence exact attachment body fetch failures are adversarially covered:
  failed `fetch_attachment_text` calls preserve `attachment_details`,
  `detail_error_summary`, and HTTP status without broadening into CQL, page
  listing, page body, comments, history, versions, or unrelated attachments.
- Confluence exact page body fetch failures are now adversarially covered:
  failed `fetch_page_body` calls for explicit `page_ids` keep page detail/error
  evidence and HTTP status without broadening into CQL, page listing, comments,
  history, versions, or attachment scans.
- GitHub service-task evidence now records API-selected file and hot-path blob
  detail targets with repo/path/ref, candidate source/query, and blob SHA/size
  when available, so file fetches are auditable without digging through artifact
  metadata.
- GitHub service-task evidence now also records exact and recent commit patch
  detail targets with repo/SHA, candidate source, file list, and scannable file
  counts, making commit-patch fetches auditable alongside API file/blob detail
  scans.
- Confluence service-task evidence now records page body detail targets with
  page id, space, title, URL, version, candidate source/query, scan method, and
  fetch outcome, so primary page detail fetches are auditable like comments,
  versions, and attachments.
- Confluence CQL-selected page body fetch failures are adversarially covered:
  failed `fetch_page_body` calls from `space_cql` candidates preserve
  `page_details`, `detail_error_summary`, candidate query, and HTTP status
  without page-list fallback or comment/history/attachment broadening.
- Confluence explicit blogpost CQL detail fetch failures are covered the same
  way: failed `fetch_page_body` calls from URL-derived `explicit_cql` blogpost
  candidates preserve source/query/status evidence without page-list fallback
  or comment/history/attachment broadening.
- Confluence explicit label CQL detail fetch failures now match that coverage:
  failed `fetch_page_body` calls from URL-derived label `explicit_cql`
  candidates preserve source/query/status evidence without page-list fallback
  or comment/history/attachment broadening.
- Confluence bounded page-list detail fetch failures are adversarially covered:
  failed `fetch_page_body` calls from `space_page_list` candidates preserve
  list-attempt, `page_details`, `detail_error_summary`, and HTTP status without
  default CQL, blogpost-list, comment/history, or attachment broadening.
- GitHub service-task file/blob detail audit now records fetch outcomes
  (`fetched`, `missing`, `empty`, or `error`) plus content-present flags and
  HTTP status/error text when available, so failed or blank detail fetches are
  not mistaken for clean scans.
- GitHub malformed code-search and hot-path blob candidates now also appear in
  `file_details` with `status=error`, so invalid file identities are auditable
  from the same detail evidence as fetch failures.
- GitHub service-task commit patch detail audit now records explicit and recent
  commit outcomes (`fetched`, `missing`, `empty`, `skipped`, or `error`) plus
  content-present flags and status/error metadata, so exact commit URL fetch
  failures, recent commit listing failures, blank patches, and out-of-repo
  exact commit responses are visible from evidence without broad fallback.
- GitHub exact commit scans now retain direct `commit_shas` beyond
  `commit_limit` as skipped `commit_details`, mark `candidate_limit_hit`, and
  never fetch those commit patches or create findings.
- GitHub exact commit detail fetch failures are adversarially covered: failed
  `fetch_commit_patch` calls preserve `commit_details`,
  `detail_error_summary`, and HTTP status without broad search, hot-path
  fallback, recent-commit scans, or unrelated detail fetches.
- GitHub SSO PR URLs now route to exact `pull_numbers=[...]` API detail
  fetching. The worker disables code search, hot-path fallback, and broad
  recent-commit scans for `/pull/<number>` URLs, and the evidence records
  `pull_request_details` plus `api_pull_request_files_scan` findings. If the
  fetched PR detail belongs to another repo, it is retained as skipped
  `pull_request_details`, counted in `out_of_scope`, and excluded from
  findings. PR file API truncation now records `candidate_limit_hit`,
  `limit_skipped`, `skipped_files`, and per-file skipped
  `pull_request_details` rows instead of silently dropping over-limit file
  candidates. Exact PR candidates beyond `pull_request_limit` are retained as
  skipped `pull_request_details`, mark `candidate_limit_hit`, and never fetch PR
  file details or create findings.
- GitHub exact PR detail fetch failures are adversarially covered: failed
  `fetch_pull_request_files` calls preserve `pull_request_details`,
  `detail_error_summary`, and HTTP status without broad code search,
  hot-path fallback, recent-commit scans, or unrelated commit/issue/compare
  detail fetches.
- GitHub SSO issue URLs now route to exact `issue_numbers=[...]` API detail
  fetching. The worker disables code search, hot-path fallback, and broad
  recent-commit scans for `/issues/<number>` URLs, and the evidence records
  `issue_details` plus `api_issue_detail_scan` findings from issue
  body/comments. If the fetched issue detail belongs to another repo, it is
  retained as skipped `issue_details`, counted in `out_of_scope`, and excluded
  from findings. Issue detail comment truncation now records
  `candidate_limit_hit`, `limit_skipped`, and per-comment skipped
  `issue_details` rows instead of silently dropping over-limit comments. Exact
  issue candidates beyond `issue_limit` are retained as skipped
  `issue_details`, mark `candidate_limit_hit`, and never fetch issue bodies or
  create findings.
- GitHub SSO compare URLs now route to exact `compare_refs=[...]` API detail
  fetching. The worker disables code search, hot-path fallback, and broad
  recent-commit scans for `/compare/<base>...<head>` URLs, and the evidence
  records `compare_details`, source/kind/query status counts, and
  `api_compare_files_scan` findings. If the fetched compare detail belongs to
  another repo, it is retained as skipped `compare_details`, counted in
  `out_of_scope`, and excluded from findings. Compare API file truncation now
  records `candidate_limit_hit`, `limit_skipped`, `skipped_files`, and per-file
  skipped `compare_details` rows instead of silently dropping over-limit file
  candidates. Exact compare candidates beyond `compare_limit` are retained as
  skipped `compare_details`, mark `candidate_limit_hit`, and never fetch compare
  file details or create findings.
- GitHub exact compare detail fetch failures are adversarially covered: failed
  `fetch_compare_files` calls preserve `compare_details`,
  `detail_error_summary`, and HTTP status without broad code search,
  hot-path fallback, file/blob fetches, recent-commit scans, or unrelated
  commit/PR detail fetches.
- GitHub global code-search URLs with a single `org:<ORG>` or `user:<OWNER>`
  qualifier and visible search terms now route to bounded
  `github_task_scan(org=..., api_search_first=True, code_search_terms=...)`
  candidate searches. Repo URLs still win over query owner qualifiers, and
  owner-only queries without concrete terms remain browser/sweep scoped.
- GitHub blob/raw/blame file URLs now follow an exact API detail path:
  visible ref and file path become `file_paths=[...]` with broad code search,
  hot-path fallback, and recent commit scanning disabled before browser
  deep-dive. Exact file candidates beyond `max_candidate_files` are retained as
  skipped `file_details`, mark `candidate_limit_hit`, and never fetch file
  bodies or create findings.
- GitHub exact file detail fetch failures are adversarially covered: failed
  `fetch_file_at_ref` calls preserve `file_details`, `detail_error_summary`,
  and HTTP status without broad code search, hot-path fallback, directory,
  commit, PR, issue, compare, release, or recent-commit detail fetches.
- GitHub tree URLs now follow an exact API directory path: visible ref and
  directory path become `directory_paths=[...]`, only blobs below that
  directory are listed/fetched by API, and broad code search, hot-path fallback,
  and recent commit scanning are disabled before browser deep-dive. Blobs whose
  API repo differs from the requested repo are retained as skipped
  `file_details`, counted in `out_of_scope`, and excluded from blob fetches.
  Exact directory candidates beyond `max_candidate_files` are retained as
  skipped `file_details`, mark `candidate_limit_hit`, and never list directory
  blobs or create findings.
- GitHub exact directory listing failures are adversarially covered: failed
  `list_directory_blobs` calls preserve `file_details`,
  `detail_error_summary`, and HTTP status without broad code search,
  hot-path fallback, exact-file, blob, commit, PR, issue, compare, release, or
  recent-commit detail fetches.
- GitHub exact directory blob detail failures are adversarially covered: after
  directory listing succeeds, failed `fetch_blob_text` calls preserve
  `file_details`, `detail_error_summary`, and HTTP status without broad code
  search, hot-path fallback, exact-file fetches, or recent-commit scans.
- Confluence SSO version/diff URLs now route to exact
  `page_versions=[{page_id, version}]` API detail fetching for historical page
  bodies. The scanner fetches only the selected version body, records
  `version_details`, and avoids current page, comment, history, attachment,
  CQL, and page-list broadening for exact version passes. The worker keeps
  attachment `version=` query parameters separate so download URLs remain
  page-id scoped attachment checks.
- Confluence direct comment URLs with `focusedCommentId` or `#comment-...` now
  route to exact `comment_ids=[{page_id, comment_id}]` API detail fetching.
  The scanner fetches only that comment body, records `comment_details`, and
  avoids page-wide comment listing for the exact comment pass. If the fetched
  comment belongs to another page, it is retained as skipped detail evidence,
  counted in `out_of_scope`, and excluded from findings.
- Confluence direct attachment URLs now preserve the visible download path as
  `attachment_downloads=[{page_id, download_url}]`; the scanner lists page
  attachments first, fetches only the exact matching attachment detail even
  when broad attachment scanning is disabled, and audits missing exact matches
  as failed detail targets instead of scanning page bodies, history, comments,
  or unrelated attachments.
- Confluence service-task comment, historical-version, and attachment detail
  audit now records fetch/list outcomes (`fetched`, `missing`, `empty`,
  `same_as_current`, or `error`) plus content-present flags and HTTP/error
  metadata, so subresource failures are visible without being confused with
  clean scans.
- Confluence malformed CQL/fallback page, historical-version, and attachment
  candidates now also appear in `page_details`, `version_details`, or
  `attachment_details` with `status=error`, so invalid primary/subresource
  identities are auditable without opening the separate error list.
- GitHub and Confluence report sync now expose owner routing counters
  (`owner_recipient_count` and `owner_missing_count`) after scope validation.
  External-only owner metadata is counted as missing, matching the report-worker
  rule that `owner_recipient` must be populated before a current-cycle report
  thread can be claimed for delivery.
- GitHub and Confluence POP3 reply correlation now matches active HITL follow-up
  statuses (`exception_review`, `owner_update_needed`,
  `owner_reassignment_review`, `reassigned`, `escalated`) in addition to normal
  owner/recheck states, while still rejecting replies older than the latest
  outbound report or guidance mail.
- Service-domain POP3 reply classifier adversarial coverage now pins
  business-exception, not-owner, and still-needed replies outside the recheck
  queue: they route to HITL or owner-wait states with persisted decision
  reasons and extracted owner hints instead of being treated as remediation
  claims.
- Shared reply quote rendering now preserves safe inline styles and
  `data:image` Original Message images while removing unsafe CSS
  `url()`/`expression()`/`javascript:`/`data:` styles across SMB, GitHub, and
  Confluence reply/recheck mails.
- GitHub direct release-tag URLs now map to exact API detail scans:
  `/releases/tag/<tag>` becomes `release_tags=[...]`, disables broad code
  search/hot-path/recent-commit fallback, and records `release_details` plus
  `api_release_detail_scan` evidence for release notes and asset metadata. If
  the fetched release belongs to another repo, it is retained as skipped
  `release_details`, counted in `out_of_scope`, and excluded from findings.
  Release asset metadata truncation now records `candidate_limit_hit`,
  `limit_skipped`, and per-asset skipped `release_details` rows instead of
  silently scanning or retaining over-limit asset strings. Exact release tag
  candidates beyond `release_limit` are retained as skipped `release_details`,
  mark `candidate_limit_hit`, and never fetch release details or create
  findings.
- GitHub exact release detail fetch failures are adversarially covered: failed
  `fetch_release_by_tag` calls preserve `release_details`,
  `detail_error_summary`, and HTTP status without broad search, hot-path
  fallback, release-list calls, recent-commit scans, or unrelated detail fetches.
- GitHub release-list URLs now map to bounded API release candidate scans:
  `/releases` becomes `include_releases=True`, disables broad code
  search/hot-path/recent-commit fallback, and records release notes plus asset
  metadata in `release_details` with `candidate_source=release_list`.
- GitHub branch-list URLs now map to bounded API branch candidate scans:
  `/branches` becomes `include_branches=True`, disables broad code
  search/recent-commit fallback, and records branch hot-path blob details with
  `candidate_source=branch_list`. Out-of-scope branch candidates are retained
  as skipped `branch_details` before blob listing. Branch hot-path blob
  selection records `candidate_limit_hit` and skipped counts at both API-search
  and list-attempt levels when `max_files_per_repo` truncates selected blob
  details; out-of-scope blob candidates are retained as skipped `file_details`
  and do not inflate selected detail scans.
- GitHub tag-list URLs now map to bounded API tag candidate scans:
  `/tags` becomes `include_tags=True`, disables broad code
  search/recent-commit fallback, and records tag hot-path blob details with
  `candidate_source=tag_list`. Out-of-scope tag candidates are retained as
  skipped `tag_details` before blob listing. Tag commit hot-path blob selection
  records `candidate_limit_hit` and skipped counts at both API-search and
  list-attempt levels when `max_files_per_repo` truncates selected blob details;
  out-of-scope blob candidates are retained as skipped `file_details` and do not
  inflate selected detail scans.
- GitHub commit-list URLs now map to bounded API commit candidate scans:
  `/commits` becomes `include_commit_list=True`, disables broad code
  search/hot-path/recent-commit fallback, and records commit patch details with
  `candidate_source=commit_list`.
- GitHub pull-request-list URLs now map to bounded API PR candidate scans:
  `/pulls` becomes `include_pull_requests=True`, disables broad code
  search/hot-path/recent-commit fallback, and records PR files patch details
  with `candidate_source=pull_request_list`.
- GitHub issue-list URLs now map to bounded API issue candidate scans:
  `/issues` becomes `include_issues=True`, disables broad code
  search/hot-path/recent-commit fallback, and records issue body/comment
  details with `candidate_source=issue_list`.
- GitHub root tree URLs now map to exact API directory scans:
  `/tree/<ref>` becomes `directory_paths=["."]`, disables broad code
  search/hot-path/recent-commit fallback, and records root-tree file details
  through the existing `api_directory_tree_scan` evidence path.
- Confluence dated blogpost URLs now map to API-first blogpost CQL detail scans:
  `/display/SPACE/YYYY/MM/DD/Title` and `/spaces/SPACE/blog/YYYY/MM/DD/Title`
  become `type = blogpost AND title ~ "Title"` CQL candidates, and the worker
  explicitly avoids treating the year/month/day path as a page title.
- Confluence label URLs now map to API-first label CQL detail scans:
  `/label/SPACE/label` and `/labels/viewlabel.action?key=SPACE&label=label`
  become `space = "SPACE" AND label = "label"` CQL candidates before
  browser/web deep-dive; arbitrary non-label page query parameters are not
  treated as label intent.
- Confluence page-list URLs now map to bounded API page-list scans:
  `/spaces/SPACE/pages` and `/pages/listpages.action?key=SPACE` become
  `include_pages=True`, enumerate only that space's bounded page list by API,
  and fetch page details from those candidates without default CQL terms,
  `list_pages` fallback accounting, or browser page-tree crawl broadening.
  When `max_pages` truncates explicit page-list selection, both the list
  attempt and top-level API-search metadata record `candidate_limit_hit` and
  skipped counts. Out-of-space page-list candidates are retained as skipped
  `page_details` and do not inflate selected body fetches.
- Confluence blog-list URLs now map to bounded API blogpost-list scans:
  `/spaces/SPACE/blog` becomes `include_blogposts=True`, enumerates only that
  space's bounded blogpost list by API, and fetches blogpost details from those
  candidates without default CQL terms, page-list scans, or browser blog-tree
  crawl broadening. When `max_pages` truncates explicit blogpost selection, both
  the list attempt and top-level API-search metadata record
  `candidate_limit_hit` and skipped counts. Out-of-space blogpost candidates are
  retained as skipped `page_details` and do not inflate selected body fetches.
- Confluence attachment-list URLs now map to bounded page-scoped attachment
  scans: `/pages/viewpageattachments.action?pageId=<page_id>` becomes
  `include_attachments=True`, lists only that page's attachments by API, fetches
  bounded text attachment details, and avoids page body, comment, history,
  default CQL, and browser page-tree broadening. Attachments whose API parent
  page differs from the requested page are retained as skipped
  `attachment_details` and never fetched; only in-scope, identity-valid
  attachment candidates inflate selected/body-fetch counts.
- API-list lanes now treat candidate lists with only blank/missing detail
  responses as scan errors instead of clean tasks: GitHub release-list,
  branch-list, tag-list, commit-list, pull-request-list, and issue-list plus
  Confluence page-list, blog-list, and attachment-list counts all participate
  in the shared status calculation and preserve their candidate lane in
  `status_reason`.
- GitHub release-list scans now enforce `release_limit` at the tool boundary
  even if an adapter over-returns candidates: excess releases are retained as
  skipped `release_details`, counted in `limit_skipped`, and excluded from
  release detail scanning and finding creation.
- GitHub branch-list scans now enforce `branch_limit` at the tool boundary even
  if an adapter over-returns candidates: excess branches are retained as
  skipped `branch_details`, counted in `limit_skipped`, and never reach
  branch-scoped blob listing or blob detail fetch.
- GitHub tag-list scans now enforce `tag_limit` at the tool boundary even if an
  adapter over-returns candidates: excess tags are retained as skipped
  `tag_details`, counted in `limit_skipped`, and never reach commit-scoped blob
  listing or blob detail fetch.
- GitHub commit-list scans now enforce `commit_limit` at the tool boundary even
  if an adapter over-returns candidates: excess commits are retained as skipped
  `commit_details`, counted in `limit_skipped`, and never reach commit patch
  scanning or finding creation.
- GitHub pull-request-list scans now enforce `pull_request_limit` at the tool
  boundary even if an adapter over-returns candidates: excess PRs are retained
  as skipped `pull_request_details`, counted in `limit_skipped`, and never
  reach PR file detail scanning or finding creation.
- GitHub issue-list scans now enforce `issue_limit` at the tool boundary even
  if an adapter over-returns candidates: excess issues are retained as skipped
  `issue_details`, counted in `limit_skipped`, and never reach issue
  body/comment detail scanning or finding creation.
- GitHub commit-list, pull-request-list, and issue-list limit attempts now
  include `limit_skipped` in their attempt-level `skipped` totals, matching the
  skipped detail evidence and release/branch/tag limit accounting.
- Confluence attachment-list scans now retain text attachment candidates beyond
  `max_attachments_per_page` as skipped `attachment_details`, counted in
  `limit_skipped`, and never fetch their attachment bodies or create findings.
- Confluence page-list and blog-list scans now retain candidates beyond
  `max_pages` as skipped `page_details`, counted in `limit_skipped`, and never
  fetch page/blog bodies or create findings.
- Confluence CQL scans now retain returned page candidates beyond `max_pages`
  as skipped `page_details`, count them in query-level `limit_skipped` and
  `skipped`, and never fetch their page bodies or create findings.
- Confluence explicit page scans now retain direct `page_ids` beyond
  `max_pages` as skipped `page_details`, mark the scan's
  `candidate_limit_hit`, and never fetch those page bodies or create findings.
- Confluence exact comment, page-version, and attachment URL scans now retain
  subresource candidates beyond `max_pages` as skipped `comment_details`,
  `version_details`, or `attachment_details`, mark `candidate_limit_hit`, and
  never fetch those subresource bodies.
- Confluence space-scoped CQL scans now also retain duplicate page candidates as
  skipped `page_details`, count them in detail status/source/query summaries,
  and still fetch the selected page body only once.
- GitHub code-search scans now retain returned file candidates beyond
  `max_candidate_files` as skipped `file_details`, count them in query-level
  `limit_skipped` and `skipped`, and never fetch those file bodies or create
  findings.
- GitHub exact file scans now retain direct `file_paths` beyond
  `max_candidate_files` as skipped `file_details`, mark `candidate_limit_hit`,
  and never fetch those file bodies or create findings.
- GitHub exact commit scans now retain direct `commit_shas` beyond
  `commit_limit` as skipped `commit_details`, mark `candidate_limit_hit`, and
  never fetch those commit patches or create findings.
- GitHub exact directory scans now retain direct `directory_paths` beyond
  `max_candidate_files` as skipped `file_details`, mark `candidate_limit_hit`,
  and never list those directories or create findings.
- GitHub exact PR scans now retain direct `pull_numbers` beyond
  `pull_request_limit` as skipped `pull_request_details`, mark
  `candidate_limit_hit`, and never fetch those PR file details or create
  findings.
- GitHub exact issue scans now retain direct `issue_numbers` beyond
  `issue_limit` as skipped `issue_details`, mark `candidate_limit_hit`, and
  never fetch those issue bodies/comments or create findings.
- GitHub exact release scans now retain direct `release_tags` beyond
  `release_limit` as skipped `release_details`, mark `candidate_limit_hit`, and
  never fetch those release details or create findings.
- GitHub exact compare scans now retain direct `compare_refs` beyond
  `compare_limit` as skipped `compare_details`, mark `candidate_limit_hit`, and
  never fetch those compare file details or create findings.
- GitHub hot-path fallback scans now retain blob candidates beyond
  `max_files_per_repo` as skipped `file_details`, counted in `limit_skipped`,
  and never fetch blob bodies or create findings.
- GitHub branch-list and tag-list hot-path detail scans now retain per-branch
  or per-tag blob candidates beyond `max_files_per_repo` as skipped
  `file_details`, counted in `limit_skipped`, and never fetch blob bodies or
  create findings.
- GitHub issue detail scans now retain comments beyond
  `max_issue_comments_per_issue` as skipped `issue_details`, mark
  `candidate_limit_hit`, and never scan those comment bodies or create findings.
- GitHub release detail scans now retain assets beyond
  `max_release_assets_per_release` as skipped `release_details`, mark
  `candidate_limit_hit`, and never scan those asset metadata strings or create
  findings.
- Confluence page-detail attachment scans now retain text attachment candidates
  beyond `max_attachments_per_page` as skipped `attachment_details`, mark
  `candidate_limit_hit`, and never fetch those attachment bodies or create
  findings.
- Confluence page history scans now retain historical version candidates beyond
  `history_versions` as skipped `version_details`, mark `candidate_limit_hit`,
  and never fetch those historical page bodies or create findings.
- Confluence page comment scans now retain comments beyond
  `max_comments_per_page` as skipped `comment_details`, mark
  `candidate_limit_hit`, and never scan those comment bodies or create findings.

## Boundary rule

Core remains domain-free. Domain queues, search/detail heuristics, reports,
reply classifiers, and dashboards stay under `secu-agent-skill` domain modules.
Only generic delivery/scheduling/protocol contracts belong in `secu-agent`.
