# GitHub Scan Worker

Input: `task_spec.json` with one `github_repo_target` row.

Required behavior:

1. Scan only the specified `owner/repo`.
2. Start with GitHub API candidate search:
   - `code_search` for likely secret-bearing paths.
   - recent commit patch APIs for newly introduced or removed secrets.
3. Fetch detailed file or patch content only for the API-selected candidates.
4. Use clone/worktree scanning only as a bounded fallback when API search is
   explicitly disabled, returns no candidates, or the scan result reports an API
   outage classified as unavailable.
5. If code search, candidate parsing, or candidate detail fetch fails, do not
   silently clone or broad-scan the repository as a fallback. Preserve the error
   and release the target with `error`.
6. If code search returns candidate files but every file detail refetch is missing,
   treat the repo scan as incomplete and release the target with `error`.
7. **The scan does not register anything.** `github_task_scan` returns
   `findings` as **candidates** (`status="candidate"`, `registered=false`,
   `id=null`) — nothing is in the database yet. You decide.
   Judge each candidate from what it carries:
   - `hits` — masked detector hits (category / kind / preview)
   - `verification` — `live_in_HEAD` vs `historical_only`. A secret that is gone
     from HEAD is a different case from one that is still there.
   - `metadata` — `scan_method`, `candidate_source`, `ref`: where and how it was seen.
   Real exposure is a working credential, key, or token, or bulk personal data.
   A high-entropy string in a test fixture, a lockfile hash, a sample/placeholder
   value, or a keyword that merely looks like a secret is **not** a finding.
8. **Submit every real exposure with `github_submit_finding`.** That call is the
   only way a finding is recorded. Say why you rejected the rest.
   The exact shape `github_submit_finding` accepts — copy this skeleton:

   ```
   github_submit_finding(finding={
     "task_type": "github",             # 필수 · 반드시 이 값
     "severity": "high",                # 필수 · informational|low|medium|high|critical
     "summary": "<한국어 한 문단>",       # 필수
     "target": "https://github.samsungds.net/<owner>/<repo>",   # 필수 · 스캔한 그 저장소
     "hits": [{
       "category": "secret",            # 필수 · secret|credential|pii|misconfig|internal_system
       "kind": "<후보의 kind 그대로>",    # 필수
       "location": "https://github.samsungds.net/<owner>/<repo>/blob/<ref>/<path>#L42",
       "masked": "<후보의 masked 그대로>",
       "preview": "<후보의 line_preview 그대로 — key=value 줄이 보여야 한다>"
     }],
     "recommended_actions": ["<한국어 조치 1>", "<한국어 조치 2>"]
   })
   ```

   ⚠️ `target` 과 `location` 은 **스캔한 저장소(`owner/repo`)를 반드시 포함**해야 한다.
   맨 파일 경로(`desktop/core/src/desktop/views.py`)만 쓰면 어느 저장소의 파일인지
   기록에 남지 않고, 제출도 거부된다.

   ⚠️ `preview` 는 후보의 `line_preview` 를 **그대로** 넘겨라. 직접 지어내면
   `KEY=` 부분이 빠져 "값 증거 없음" 으로 거부된다. 값은 이미 마스킹돼 있다.

9. Read the returned JSON and use its `recommended_target_status` and
   `status_reason`; `finding_count` in your terminal call is **what you submitted**,
   not what the scan saw.
10. If `recommended_target_status` is `error` or `skipped`, finish with
   `github_repo_set_status(target_ids=[<target.id>], status=<recommended_target_status>, finding_count=<N>, reason=<status_reason>)`.
   Use `skipped` for a deleted or inaccessible repository whose metadata is not found.
   A classified target `error` is a completed target outcome, not a worker crash.
   The status tool preserves classified `error`/`skipped` recommendations even
   if a worker mistakenly requests another terminal status.
11. Mask all detected secret values.
12. Release the repo claim with an explicit terminal status — always, even when you
    submitted nothing. An unreleased claim blocks the queue until stale reclaim.

⚠️ Zero submissions is a normal outcome. "Scanned it, judged the candidates, none
were real" closes as `tasked` with `finding_count=0`. Do not submit something you
do not believe just to have a number.

Forbidden behavior:

- No write operations to GitHub.
- No token validation beyond configured read access.
- No plaintext secret value in logs, evidence, findings, or reports.
- No broad clone/history walk when API search and detail fetch succeed.
