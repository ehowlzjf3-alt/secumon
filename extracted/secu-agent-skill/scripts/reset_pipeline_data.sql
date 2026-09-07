-- 풀 스윕 전 초기화 — **산출물만** 비운다 (사용자 결정 2026-08-25).
--
-- 【반드시 먼저】 백업. 이 스크립트는 되돌릴 수 없다.
--   pg_dump "$SECU_AGENT_PG_DSN" --format=custom --compress=6 --file=~/backups/threat_hunter-<stamp>.dump
--   그리고 **복원해서 행수를 대조**할 것 — 파일이 있는 것과 복원되는 것은 다르다.
--
-- 【분류】 지우는 것은 "다시 만들 수 있는 것" 뿐이다.
--
--   지움(산출물)   : finding·공유/폴더/파일·스레드·메일·회신·재검증·스캔·파이프라인 이력
--   살림(씨앗)     : *_target·web_target_domain·devops_target·smb_credential
--                    ★ 이걸 지우면 스윕할 대상이 없어진다.
--   살림(담당자)   : asset_owner·employee_directory·github_repo_owner
--                    ★ 이걸 지우면 Splunk·Knox 재조회 전까지 수신처가 전부 빈다.
--   살림(운영)     : control_flag(cron on/off)·schema_version(DDL 버전)·state_meta
--                    ★ schema_version 을 지우면 마이그레이션이 깨진다.
--   살림(에이전트) : chat_*·memory_rule·schedule*·token_usage·paste_cache
--                    스윕 산출물이 아니다.
--
-- 【★ 진행상태 초기화가 삭제만큼 중요하다】
--   대상 테이블은 지우지 않고 **상태를 되돌린다**. 안 하면 전부 "이미 처리함" 으로
--   건너뛰어, 스윕이 0건으로 끝나고 그게 "깨끗하다" 로 보인다.
--
-- 【실행】
--   psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -f scripts/reset_pipeline_data.sql

\set ON_ERROR_STOP on

BEGIN;

-- ── ① 산출물 삭제 ───────────────────────────────────────────────────────────
-- TRUNCATE ... CASCADE 를 쓰지 않는다 — 무엇이 딸려 지워지는지 안 보인다.
-- 자식부터 명시적으로, 순서대로 지운다.

TRUNCATE TABLE
  public.smb_file_hit,
  public.smb_file,
  public.smb_directory,
  public.smb_share
  RESTART IDENTITY;

TRUNCATE TABLE
  public.mail_message,
  public.mail_reply_decision,
  public.mail_reverify_result,
  public.mail_thread
  RESTART IDENTITY;

TRUNCATE TABLE
  public.github_report_thread,
  public.github_recheck_result,
  public.confluence_report_thread,
  public.confluence_recheck_result,
  public.dev_web_report_thread,
  public.dev_web_recheck_result
  RESTART IDENTITY;

TRUNCATE TABLE
  public.scan,
  public.screenshot,
  public.credential_probe_attempt,
  public.confluence_search_target
  RESTART IDENTITY;

TRUNCATE TABLE
  core.finding_lifecycle,
  core.finding_index
  RESTART IDENTITY;

TRUNCATE TABLE
  platform.pipeline_run,
  platform.pipeline_heartbeat,
  platform.service_reply_message,
  skill_quality.worker_candidate_event
  RESTART IDENTITY;

-- ── ② 대상 테이블 진행상태 초기화 (행은 살린다) ─────────────────────────────
-- ★ 이걸 빼먹으면 스윕이 전부 "이미 함" 으로 건너뛴다 — 0건으로 끝나고 깨끗해 보인다.

-- ⚠️ 컬럼이 테이블마다 다르다. 실제 스키마를 확인하고 쓴 것이다 —
--    없는 컬럼을 UPDATE 하면 트랜잭션 전체가 롤백된다.

-- smb: status 컬럼이 없다. 스윕 이력(swept_at·hosts_found…)과 claim 을 되돌린다.
UPDATE public.smb_target_subnet
   SET swept_at = NULL, sweep_scan_id = NULL,
       hosts_found = 0, shares_found = 0,
       claimed_by = NULL, claimed_at = NULL,
       cycle_key = NULL, cycle_swept_at = NULL,
       cycle_hosts_found = 0, cycle_shares_found = 0
 WHERE TRUE;

-- github·confluence: report_thread_id 컬럼이 없다.
UPDATE public.github_repo_target
   SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
       finding_count = 0, cycle_key = NULL,
       -- ⚠️ 이력 컬럼도 지운다 — 안 지우면 옛 값이 새 스윕의 진척으로 오독된다.
       last_reason = NULL, last_scanned_at = NULL, retry_after = NULL,
       last_scanned_sha = NULL,
       cycle_scanned_at = NULL, cycle_finding_count = 0
 WHERE TRUE;

UPDATE public.confluence_space_target
   SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
       finding_count = 0, cycle_key = NULL,
       -- ⚠️ 이력 컬럼도 지운다 — 안 지우면 옛 값이 새 스윕의 진척으로 오독된다.
       last_reason = NULL, last_scanned_at = NULL, retry_after = NULL,
       cycle_scanned_at = NULL, cycle_finding_count = 0
 WHERE TRUE;

-- dev_web 만 report_thread_id 를 갖는다. 스레드를 지웠으니 참조도 끊는다.
-- ⚠️ **이력 컬럼도 지운다.** 처음엔 status·claim 만 되돌렸는데, `last_reason`·
--    `last_task_at` 에 옛 값이 남아 새 스윕의 진척으로 오독됐다(2026-08-25 실측:
--    `last_task_at` 1,414건 중 오늘 것은 11건뿐, 나머지는 08-24 이전 잔재).
--    "무엇을 안 지웠나" 가 "무엇을 지웠나" 만큼 중요하다.
UPDATE public.dev_web_target
   SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
       finding_count = 0, cycle_key = NULL, report_thread_id = NULL,
       last_reason = NULL, last_task_at = NULL, evidence_ref = NULL,
       retry_after = NULL
 WHERE TRUE;

COMMIT;

-- ── ③ 확인 ─────────────────────────────────────────────────────────────────
\echo ''
\echo '=== 산출물(0 이어야 함) ==='
SELECT 'finding_lifecycle' t, count(*) n FROM core.finding_lifecycle
UNION ALL SELECT 'smb_share', count(*) FROM public.smb_share
UNION ALL SELECT 'smb_file', count(*) FROM public.smb_file
UNION ALL SELECT 'mail_thread', count(*) FROM public.mail_thread
UNION ALL SELECT 'github_report_thread', count(*) FROM public.github_report_thread
UNION ALL SELECT 'pipeline_run', count(*) FROM platform.pipeline_run
ORDER BY 1;

\echo ''
\echo '=== 씨앗·참조(살아 있어야 함) ==='
-- ⚠️ smb_target_subnet 엔 status 가 없다. '미스윕' 은 swept_at IS NULL 로 본다.
SELECT 'smb_target_subnet' t, count(*) n,
       count(*) FILTER (WHERE swept_at IS NULL) AS 미처리 FROM public.smb_target_subnet
UNION ALL SELECT 'github_repo_target', count(*),
       count(*) FILTER (WHERE status='pending') FROM public.github_repo_target
UNION ALL SELECT 'confluence_space_target', count(*),
       count(*) FILTER (WHERE status='pending') FROM public.confluence_space_target
UNION ALL SELECT 'dev_web_target', count(*),
       count(*) FILTER (WHERE status='pending') FROM public.dev_web_target
UNION ALL SELECT 'asset_owner', count(*), NULL FROM public.asset_owner
UNION ALL SELECT 'employee_directory', count(*), NULL FROM public.employee_directory
UNION ALL SELECT 'smb_credential', count(*), NULL FROM public.smb_credential
ORDER BY 1;
