-- ============================================================
-- digisecu M4 게이트웨이 전용 read-only DB role (threat_hunter)
-- ============================================================
-- 【사용자님이 직접 실행】 threat_hunter DB의 소유자/슈퍼유저로 psql에서 실행하세요.
-- Claude는 자격증명을 취급하지 않습니다 — 아래 비밀번호를 실제 값으로 바꿔 실행하세요.
--   psql "postgresql://<admin>@<host>:5432/threat_hunter" \
--        -v ON_ERROR_STOP=1 -v gw_password="실제강력한비밀번호" -f 001_readonly_role.sql
--   (gw_password 값에 따옴표를 넣지 마세요 — 아래 %L 이 안전하게 quote 합니다.)
--
-- 설계 근거(codex #5): read-only는 기밀성 경계가 아니다. 광범위 GRANT면 게이트웨이 침해 시
-- 공유 DB 전체가 유출된다. 따라서 (a) 게이트웨이 repos 가 **실제 SELECT 하는 11개 테이블만**,
-- (b) 자격증명(smb_credential)·마스킹 우회 색인(finding_index)·스크린샷(screenshot)은 **미부여+명시 REVOKE**,
-- (c) role 레벨 default_transaction_read_only=on 으로 write/DDL을 서버측에서 봉인.
--
-- 【v3.88 StatePort 스키마 분리】 P1: 코어 16테이블 public→`core`(finding_lifecycle 포함). P2: 스킬 테이블
-- public→`skill_<d>`, platform 테이블 public→`platform`. 이 스크립트는 각 테이블을 **현재 위치(public)와
-- 컷오버 후 위치(core/skill_*) 양쪽**에 to_regclass 가드로 GRANT → P1직후·P2직후 어느 시점에 재실행해도 안전·멱등.
-- 컷오버(ALTER SET SCHEMA)로 테이블이 이동한 뒤 이 스크립트를 다시 실행해 grant 를 새 위치에 재부여하세요.
--
-- ⚠ 엔진 SA_PG_READONLY_ROLE: state.py `_grant_readonly` 는 GRANT SELECT ON **ALL TABLES** 라 광범위하다.
--   SA_PG_READONLY_ROLE 를 digisecu_gw_ro 로 설정하면 부팅 시 core/platform/skill_* 의 finding_index·smb_credential·
--   screenshot 까지 재개방된다(codex B). **권장: 게이트웨이 롤을 SA_PG_READONLY_ROLE 로 쓰지 말 것**(별도 롤 사용).
--   부득이하면 엔진 부팅 **뒤** 이 스크립트를 재실행하라 — §4b desired-state 리셋(관리 스키마 SELECT 전체 회수 후 11개만
--   재부여)으로 엔진의 ALL-TABLES grant 까지 걷어내 최소권한으로 **완전 수렴**한다(codex D).
--   단 default privileges(ALTER DEFAULT PRIVILEGES)·PUBLIC·상속 롤 경유 권한은 이 스크립트가 다루지 않으니 그 경로를 쓰면
--   grant 주체 롤로 별도 회수 필요.
-- ============================================================

-- 1) 로그인 role 생성/갱신. ★psql 은 dollar-quoted(DO $$...$$) 블록 안에서 :변수를 치환하지 않는다(공식 규칙).
--    그래서 DO 블록 대신 top-level \gexec — :'gw_password' 는 여기서 치환되고 %L 이 SQL 리터럴로 안전 quote.
SELECT format('CREATE ROLE digisecu_gw_ro LOGIN PASSWORD %L', :'gw_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'digisecu_gw_ro')
\gexec
SELECT format('ALTER ROLE digisecu_gw_ro LOGIN PASSWORD %L', :'gw_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'digisecu_gw_ro')
\gexec

-- 2) role 레벨 read-only 강제(3층 방어의 서버측 축) + search_path.
ALTER ROLE digisecu_gw_ro SET default_transaction_read_only = on;
ALTER ROLE digisecu_gw_ro SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE digisecu_gw_ro SET statement_timeout = '5s';
ALTER ROLE digisecu_gw_ro SET search_path = core, platform, skill_smb, skill_dev_web, skill_github, skill_confluence, skill_quality, public;

-- 3) 접속 + public 사용(전이 fallback). public 에 객체 생성 금지(직접+PUBLIC 경유 모두).
GRANT CONNECT ON DATABASE threat_hunter TO digisecu_gw_ro;
GRANT USAGE ON SCHEMA public TO digisecu_gw_ro;
REVOKE CREATE ON SCHEMA public FROM digisecu_gw_ro;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 4) 스키마 USAGE(존재하는 것만) + 테이블 SELECT. **게이트웨이 repos 가 실제 쿼리하는 11개만**(최소권한).
--    각 테이블은 현재 위치(public)와 컷오버 후 위치 양쪽에 시도 → 이동 전후 어디서 실행해도 멱등.
DO $$
DECLARE
  sch text;
  i int;
  -- (컷오버후_스키마, 테이블). 실제 SELECT 하는 것만(finding + 큐/리포트 스레드).
  -- 미쿼리 테이블(smb_file/smb_file_hit/devops_target/scan/asset_owner/pipeline_*/control_flag)은 **부여하지 않음**.
  q text[][] := ARRAY[
    ['core','finding_lifecycle'],
    ['skill_smb','smb_share'], ['skill_smb','smb_target_subnet'], ['skill_smb','mail_thread'],
    ['skill_dev_web','web_target_domain'], ['skill_dev_web','dev_web_target'], ['skill_dev_web','dev_web_report_thread'],
    ['skill_github','github_repo_target'], ['skill_github','github_report_thread'],
    ['skill_confluence','confluence_space_target'], ['skill_confluence','confluence_report_thread']
  ];
BEGIN
  -- 4a) USAGE — 존재하는 스키마에만. (skill_quality 포함 — 단 SELECT 는 sql/003 이 VIEW 에만 부여.)
  FOREACH sch IN ARRAY ARRAY['core','platform','skill_smb','skill_dev_web','skill_github','skill_confluence','skill_quality']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sch) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO digisecu_gw_ro', sch);
    END IF;
  END LOOP;

  -- 4b) ★desired-state 리셋(codex D): 관리 스키마의 기존 SELECT 를 **전부 회수**(과거 스크립트/엔진 _grant_readonly 의
  --     ALL TABLES 광범위 grant 제거) 후 4c 에서 11개만 재부여 → 재실행 시 최소권한으로 수렴(멱등).
  FOREACH sch IN ARRAY ARRAY['public','core','platform','skill_smb','skill_dev_web','skill_github','skill_confluence','skill_quality']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sch) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM digisecu_gw_ro', sch);
    END IF;
  END LOOP;
  -- ★ 4b 가 skill_quality VIEW SELECT 도 회수한다 — 001 재적용 후엔 002 와 함께 003 재실행 필수.

  -- 4c) 테이블 SELECT — **target 우선, 없으면 public**(둘 다 존재해도 target 만; split-brain 시 stale public 노출 방지·codex D).
  FOR i IN 1 .. array_length(q, 1) LOOP
    IF to_regclass(format('%I.%I', q[i][1], q[i][2])) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO digisecu_gw_ro', q[i][1], q[i][2]);
    ELSIF to_regclass(format('public.%I', q[i][2])) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO digisecu_gw_ro', q[i][2]);
    END IF;
  END LOOP;
END
$$;

-- 5) 방어적 회수 — 자격증명/마스킹 우회 색인/스크린샷은 어느 스키마에 있든 명시 차단(실재하는 위치만).
--    screenshot 은 P2 재귀속으로 skill_smb 소유(과거 platform 아님) — 두 위치 다 커버.
DO $$
DECLARE
  pair text[][] := ARRAY[
    ['skill_smb','smb_credential'], ['public','smb_credential'],
    ['core','finding_index'], ['public','finding_index'],
    ['skill_smb','screenshot'], ['platform','screenshot'], ['public','screenshot']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pair, 1) LOOP
    IF to_regclass(format('%I.%I', pair[i][1], pair[i][2])) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %I.%I FROM digisecu_gw_ro', pair[i][1], pair[i][2]);
    END IF;
  END LOOP;
END
$$;

-- 확인 쿼리(선택): 부여된 테이블 목록(스키마 포함) — 11개 + 제외 확인
-- SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'digisecu_gw_ro' ORDER BY table_schema, table_name;
