-- ============================================================
-- digisecu 게이트웨이 RO 롤에 platform.pipeline_* 조회 권한 추가 (도메인 런타임 상태/활동)
-- ============================================================
-- 【사용자님이 직접 실행 — prod DDL 게이트】 threat_hunter DB 소유자/슈퍼유저로 psql 에서 실행하세요.
--   psql "postgresql://<admin>@<host>:5432/threat_hunter" -v ON_ERROR_STOP=1 -f 002_runtime_read_grants.sql
--
-- 근거(codex A2): 기술적으로 GRANT 는 DCL 이지만 **운영 통제상 prod DDL 게이트와 동일 취급**한다.
-- 앱 import/startup 에서 실행하지 않는다(게이트웨이는 read-only SELECT 만 발행).
--
-- 노출 판단: 이 두 테이블은 운영 메타데이터(component/epoch/counters/pid/free-text detail)뿐이며 레코드별
-- 시크릿은 없다. 다만 detail 은 URL/free-text 라 RO 크레덴셜 탈취 시 원문 노출 위험 → 게이트웨이가 응답 직전
-- redact(URL userinfo/query/fragment 제거 + 재마스킹 + 길이 제한)한다(runtime_service._sanitize_detail).
-- 그럼에도 최소권한 관점에서 **읽기 SELECT 2건만** 추가하며 write/DDL 은 롤 레벨 read-only(sql/001)로 봉인된다.
--
-- 멱등: 이미 부여돼 있어도 재실행 안전. sql/001 재실행 시 4b desired-state 리셋이 관리 스키마 SELECT 를
-- 전량 회수하므로 **sql/001 재적용 후에는 이 002 도 다시 실행**해야 grant 가 유지된다.
-- ============================================================

-- platform 스키마 USAGE(존재하면) — sql/001 4a 가 이미 부여했을 수 있으나 멱등 보강.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'platform') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA platform TO digisecu_gw_ro';
  END IF;
END
$$;

-- pipeline_run / pipeline_heartbeat SELECT — 존재하는 위치에만(platform 우선, 전이 대비 public fallback).
DO $$
DECLARE
  pair text[][] := ARRAY[
    ['platform','pipeline_run'], ['public','pipeline_run'],
    ['platform','pipeline_heartbeat'], ['public','pipeline_heartbeat']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pair, 1) LOOP
    IF to_regclass(format('%I.%I', pair[i][1], pair[i][2])) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO digisecu_gw_ro', pair[i][1], pair[i][2]);
    END IF;
  END LOOP;
END
$$;

-- 확인(선택):
-- SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'digisecu_gw_ro' AND table_name LIKE 'pipeline_%' ORDER BY 1,2;
