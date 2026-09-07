-- smb 도메인만 초기화 — "에이전트가 남긴 것 지우고 이번 주 새 시작" (사용자 결정 2026-08-26).
--
-- 【반드시 먼저】 백업 + **복원 대조**. 되돌릴 수 없다.
--   pg_dump "$SECU_AGENT_PG_DSN" --format=custom --compress=6 --file=~/backups/threat_hunter-<stamp>.dump
--   pg_restore --dbname=<임시DB> ... 후 행수 대조 — 파일이 있는 것과 복원되는 것은 다르다.
--
-- 【scripts/reset_pipeline_data.sql 과 무엇이 다른가】
--   저건 4도메인 전체다. 이건 **smb 만** 건드린다. github·confluence·dev_web 의
--   finding·스레드·큐는 손대지 않는다(지금 라이브로 돌고 있다).
--
-- 【분류】 지우는 것은 "다시 만들 수 있는 것" 뿐이다.
--
--   지움(산출물)  : smb finding · 공유/폴더/파일 · 메일 스레드/회신/재검증
--   살림(씨앗)    : smb_target_subnet 행 · smb_credential
--                   ★ 이걸 지우면 스윕할 대상이 없어진다.
--   살림(담당자)  : asset_owner · employee_directory
--                   ★ 이걸 지우면 Splunk/Knox 재조회 전까지 수신처가 전부 빈다.
--   살림(운영)    : control_flag · schema_version · state_meta
--
-- 【★ 진행상태 초기화가 삭제만큼 중요하다】
--   `smb_target_subnet` 은 행을 **지우지 않고 상태를 되돌린다**. 안 하면 수집기가
--   전부 "이미 스윕함" 으로 건너뛰어 0건으로 끝나고, 그게 "깨끗하다" 로 보인다.
--
-- 【실행】
--   psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -f scripts/reset_smb_only.sql

\set ON_ERROR_STOP on

BEGIN;

-- ── ① smb 산출물 삭제 ───────────────────────────────────────────────────────
-- CASCADE 를 쓰지 않는다 — 무엇이 딸려 지워지는지 안 보인다. 자식부터 순서대로.

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

-- finding 은 **task_type='smb' 만**. 다른 도메인 32,000여 건은 그대로 둔다.
DELETE FROM core.finding_lifecycle WHERE task_type = 'smb';

-- ⚠️ `core.finding_index` 는 share_id/host/path 축이라 smb 전용이고 현재 0행이다.
--    (0행이 아니어도 smb 전용이므로 전량 삭제가 맞다.)
DELETE FROM core.finding_index;

-- smb 관련 파이프라인 이력만. 다른 도메인 이력은 남긴다.
DELETE FROM platform.pipeline_run
 WHERE component IN ('task', 'smb.lead', 'mail', 'reply', 'reply_verify',
                     'collector', 'collector.sweep', 'collector.walk',
                     'walk', 'hunt', 'reverify', 'report_view');

-- 후보 침묵 이벤트(품질 read-model)도 smb 만.
DELETE FROM skill_quality.worker_candidate_event WHERE domain = 'smb';

-- ── ② 대상 테이블 진행상태 초기화 (행은 살린다) ─────────────────────────────
-- ★ 이걸 빼먹으면 수집기가 전부 "이미 함" 으로 건너뛴다 — 0건으로 끝나고 깨끗해 보인다.
-- ⚠️ smb_target_subnet 에는 status 컬럼이 **없다**. 스윕 이력과 claim 을 되돌린다.

UPDATE public.smb_target_subnet
   SET swept_at = NULL, sweep_scan_id = NULL,
       hosts_found = 0, shares_found = 0,
       claimed_by = NULL, claimed_at = NULL,
       cycle_key = NULL, cycle_swept_at = NULL,
       cycle_hosts_found = 0, cycle_shares_found = 0
 WHERE TRUE;

COMMIT;

-- ── ③ 확인 ─────────────────────────────────────────────────────────────────
\echo ''
\echo '=== smb 산출물 (0 이어야 함) ==='
SELECT 'smb_share' t, count(*) n FROM public.smb_share
UNION ALL SELECT 'smb_file', count(*) FROM public.smb_file
UNION ALL SELECT 'smb_directory', count(*) FROM public.smb_directory
UNION ALL SELECT 'smb_file_hit', count(*) FROM public.smb_file_hit
UNION ALL SELECT 'mail_thread', count(*) FROM public.mail_thread
UNION ALL SELECT 'finding(smb)', count(*) FROM core.finding_lifecycle WHERE task_type='smb'
ORDER BY 1;

\echo ''
\echo '=== 다른 도메인 finding (그대로여야 함) ==='
SELECT task_type, count(*) n FROM core.finding_lifecycle GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== 씨앗·담당자 (살아 있어야 함) ==='
SELECT 'smb_target_subnet' t, count(*) n,
       count(*) FILTER (WHERE swept_at IS NULL) AS 미스윕
  FROM public.smb_target_subnet
UNION ALL SELECT 'smb_credential', count(*), NULL FROM public.smb_credential
UNION ALL SELECT 'asset_owner', count(*), NULL FROM public.asset_owner
UNION ALL SELECT 'employee_directory', count(*), NULL FROM public.employee_directory
ORDER BY 1;
