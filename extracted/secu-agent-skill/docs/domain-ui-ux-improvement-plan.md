# Domain UI/UX Improvement Plan

2026-07-08 기준 점검 결과. 목표는 네 도메인(SMB, DevWeb, GitHub,
Confluence)의 화면을 같은 운영 문법으로 맞추는 것이다. 기능 parity 문서는
`docs/domain-parity-smb-github-confluence.md`가 계속 담당하고, 이 문서는 다음
UI/API 구현 queue를 추적한다.

## 공통 원칙

1. 모든 화면은 기본적으로 현재 주차만 보여준다. 과거 주차는 명시적으로
   선택했을 때만 조회하고, 액션은 current-cycle thread에만 허용한다.
2. `queue`, `processing`, `stuck`, `done`, `skipped`, `error`는 서로 겹치지
   않게 계산한다. 한 대상이 여러 stage 숫자에 동시에 잡히면 UI 버그로 본다.
3. 모든 report/detail 화면은 `cycle_key`, `thread_id`, `finding_ids`,
   `agent_verification`을 표시하거나 적어도 확인 가능한 drawer를 제공한다.
4. Splunk/proxy/web-log 신호는 후보/보조 신호로 표시하고, finding 근거는
   실제 API/detail/browser 검증 근거와 분리해서 보여준다.
5. 증거 화면은 마스킹된 값, detector kind, 위치(path/page/line), scan method,
   candidate source/query, evidence/refetch status를 보여주되 raw secret/PII는
   노출하지 않는다.
6. 메일 화면은 dry-run, dssoc-only, sent, failed, retry-cooldown을 별도 상태로
   표시한다.

## 이미 반영한 즉시 수정

- SMB host report API에 `cycle_key`와 `thread_id` scope를 추가했다.
  선택된 report thread의 주차와 `finding_ids`만 상세 리포트에 연결되므로,
  현재 주차 thread를 열 때 과거 주차 lifecycle finding이 섞이지 않는다.
- GitHub/Confluence report detail API는 기본 direct detail 조회도 현재 주차로
  제한하고, `cycle_key=all` 또는 명시적 과거 주차일 때만 history를 연다.
- SMB report UI는 thread detail 조회 시 `thread_id`와 thread cycle을 함께
  넘기고, 상세 상단에 주차를 표시한다.

## SMB

현재 표면:

- 정적 SPA: `domains/smb/webapp/ui/index.html`
- report API: `service/routes/smb.py`, `service/services/smb_reports.py`
- mail/thread API: `domains/smb/webapp/routes/mail_thread.py`
- pipeline projection: `domains/smb/application/pipeline_projection.py`

다음 개선:

1. Reply/Reverify 숫자 비겹침
   - `/api/mail-threads`에 inbound count, pending reply count, latest reply
     decision, reverify verdict count, retry/backoff age를 추가한다.
   - dashboard stage에는 "답장 대기", "답장 처리중", "답장 판정 완료",
     "재검증 대기", "재검증 중", "재요청/완료/HITL"을 분리한다.

2. Dry-run 가시화
   - report/mail delivery attempt를 `sent`, `dry_run`, `failed`로 남긴다.
   - UI에는 "DSSOC-only dry-run draft" badge와 본문 preview를 표시한다.

3. Owner lookup stuck panel
   - `splunk:pending`을 `pending_active`, `stale_pending`, `missing`, `error`
     bucket으로 분리한다.
   - stale owner lookup은 reset/retry action과 `source`, `updated_at`,
     `last_reason`을 노출한다.

4. Agent verification provenance
   - share/file/finding row에서 진성 badge 클릭 시 agent note, confidence,
     detector checks, transcript/evidence ref를 열 수 있게 한다.

5. Share/finding count clarity
   - "발견 share", "print$ 제외", "리포트 대상 share", "finding 대상 IP"를
     같은 카드에 섞지 않고 별도 legend로 분리한다.

## DevWeb

현재 표면:

- 웹 서버 root는 API link page뿐이다: `domains/dev_web/webapp/app.py`
- API: `domains/dev_web/webapp/routes/{pipeline,targets,control}.py`
- projection: `domains/dev_web/application/pipeline_projection.py`

다음 개선:

1. 실제 dashboard shell 추가
   - `domains/dev_web/webapp/ui/index.html`을 만들고 `/`에서 서빙한다.
   - 탭은 Pipeline, Targets, Reports, Evidence, Controls로 구성한다.

2. Report detail API 추가
   - `GET /api/dev-web/reports/{thread_id}`를 추가한다.
   - 반환값에는 parsed `report_json`, finding row, `cycle_keys`,
     `is_current_cycle`, recurrence count, action flags가 포함되어야 한다.

3. Browser deep-dive evidence drawer
   - `dev_web_submit_finding`의 `evidence_ref`를 path-jailed endpoint로 연다.
   - screenshot/html/snapshot, post-sweep browser action, submitted finding
     checks를 표시한다.

4. Splunk candidate trace
   - pipeline target preview가 domain 문자열만 주는 대신 `source`,
     `day_bucket`, `event_count`, `priority_score`, SPL/filter metadata를
     반환한다.

5. Stage count grammar 정리
   - GitHub/Confluence처럼 `targets.active/next/stuck` 객체와
     `queue/processing/stuck/done` scalar를 함께 제공한다.

## GitHub

현재 표면:

- 정적 SPA: `domains/services/github/webapp/ui/index.html`
- routes: `domains/services/github/webapp/routes.py`
- scanner/evidence: `domains/services/github/application/scanner.py`

다음 개선:

1. Discovery/scan-limit panel
   - repo discovery 제한, org/repo enumeration 결과, archived/private 정책,
     API auth/rate-limit, candidate-limit hit, fallback-used count, retry reason,
     last run detail을 표시한다.

2. High-entropy evidence UX
   - report detail API가 sanitized `evidence_summary`를 제공한다.
   - UI는 masked hit, detector kind, entropy bucket, path/line, scan method,
     candidate source/query를 first-class chip/column으로 보여준다.

3. Repo/system importance
   - repo visibility, archived flag, size, pushed_at, owner/system hint,
     business criticality, proxy access count를 `repo_importance`로 project한다.
   - row 정렬과 severity 설명에 중요도 신호를 포함한다.

4. Splunk/proxy signal labeling
   - proxy-log discovery stage는 "Proxy URL signal"로 라벨링한다.
   - report detail에서는 GitHub API evidence와 proxy-derived discovery
     context를 분리한다.

5. Owner and agent verification
   - `owner_state`, `owner_source`, candidate owners, extracted reply owner,
     last reason을 표시한다.
   - `agent_verification_counts`, skipped-unverified count, method/checklist를
     report list/detail에 추가한다.

## Confluence

현재 표면:

- 정적 SPA: `domains/services/confluence/webapp/ui/index.html`
- routes: `domains/services/confluence/webapp/routes/api.py`
- scanner tests already cover credential, document sensitivity, comments,
  attachments, history, CQL candidate trace.

다음 개선:

1. 민감도 카테고리 필터
   - credential/API key/password/private key 외에 `bulk_pii_hr`,
     `executive_minutes`, `business_confidential`,
     `semiconductor_process`/`process_info`를 UI filter로 추가한다.
   - 단순 담당자 연락처 등 low-value contact-only excluded count를 보여준다.

2. Evidence surface badges
   - page, comment, attachment, historical version, blogpost/detail scan을
     badge로 분리한다.
   - 각 finding row에서 CQL query, candidate source, scan method,
     matched surface count를 바로 확인할 수 있게 한다.

3. Attachment/history limits
   - 큰 첨부/히스토리 스캔 제한, skipped/error reason, retry 상태를 별도
     panel로 표시한다.

4. Agent verification visibility
   - 현재 report sync는 verification gate를 적용하지만 UI에는 method/checks가
     약하다. verified/skipped-unverified counts와 per-finding checklist를
     추가한다.

5. Owner/HITL panel
   - space/page owner source, confidence, reassignment audit, exception approval
     state를 GitHub와 같은 컴포넌트로 맞춘다.

## 구현 순서

1. API contract pass
   - 네 도메인 report/detail response에 `cycle_key`, `current_cycle_key`,
     `cycle_keys`, `is_current_cycle`, `agent_verification`,
     `report_skip_reason`, `owner_state`, `evidence_summary`를 정렬한다.

2. Stage count pass
   - DevWeb를 GitHub/Confluence projection shape로 맞춘다.
   - SMB reply/reverify, owner lookup stuck buckets를 분리한다.

3. Evidence drawer pass
   - SMB: agent transcript/evidence refs.
   - DevWeb: browser deep-dive artifacts.
   - GitHub: high entropy and code-search detail.
   - Confluence: page/comment/attachment/history/CQL trace.

4. Mail/dry-run pass
   - SMB, GitHub, Confluence, DevWeb 모두 delivery attempt status를 UI에 노출한다.
   - dry-run은 dssoc-only로 명확히 표시하고 owner 발송과 시각적으로 구분한다.

5. Playwright verification
   - 각 도메인 desktop/mobile screenshot을 찍어 text overlap, empty state,
     cycle selector, detail drawer, stuck reset action을 확인한다.

## Adversarial checks

- current-cycle list에서 old-cycle detail URL을 직접 열면 404가 나와야 한다.
- `cycle_key=all`은 읽기 전용 history로 열리되 action button은 비활성화되어야 한다.
- 미검증 finding은 report/mail queue에 보이지 않고, skipped-unverified로 집계되어야 한다.
- dry-run은 sent로 카운트되지 않아야 한다.
- proxy/Splunk-only signal은 confirmed finding처럼 렌더링되면 안 된다.
- low-value contact-only Confluence item은 reportable finding으로 승격되지 않아야 한다.
