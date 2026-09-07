-- ============================================================
-- digisecu 게이트웨이 RO 롤에 skill_quality candidate 품질 VIEW 조회 권한 추가 (#1 눈)
-- ============================================================
-- 【사용자님이 직접 실행 — prod DDL 게이트】 threat_hunter DB 소유자/슈퍼유저로 psql 에서 실행하세요.
--   psql "postgresql://<admin>@<host>:5432/threat_hunter" -v ON_ERROR_STOP=1 -f 003_quality_read_grants.sql
--
-- 전제: skill_quality 스키마/테이블/뷰는 스킬측 명시 적용이 선행돼야 합니다(순서 고정):
--   1) secu-agent-skill 에서 `python -m service.agents.quality_events --apply-schema` (writer 권한)
--   2) 이 003 실행
-- 002 와 달리 to_regclass no-op 패턴을 쓰지 않습니다 — 신규 단일 위치(skill_quality)라 위치 전이가
-- 없고, 뷰 미존재는 "적용 순서 오류"이므로 조용히 성공하는 대신 즉시 실패(fail-loud)합니다.
--
-- 기밀성 경계(codex): GRANT 는 **VIEW(worker_candidate_quality) 에만** — base table
-- (worker_candidate_event)은 부여하지 않습니다. RO 롤이 읽을 수 있는 컬럼 집합을 뷰가 고정하므로,
-- 이후 base table 에 컬럼이 추가돼도 게이트웨이 노출은 뷰 갱신 없이는 늘지 않습니다.
-- (뷰 자체도 라벨/경로 무포함 — 카운트/enum/UUID/epoch 만.)
--
-- 멱등: 재실행 안전. sql/001 재실행 시 4b desired-state 리셋이 관리 스키마(skill_quality 포함) SELECT 를
-- 전량 회수하므로 **sql/001 재적용 후에는 002 와 함께 이 003 도 다시 실행**해야 합니다.
-- ============================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  -- fail-loud 전제 검증 — 스키마/뷰가 없으면 적용 순서 오류.
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'skill_quality') THEN
    RAISE EXCEPTION 'skill_quality 스키마 없음 — 먼저 스킬측 apply-schema 를 실행하세요 '
      '(python -m service.agents.quality_events --apply-schema)';
  END IF;
  -- 같은 이름의 table/matview 가 아니라 진짜 VIEW(relkind=v)인지까지 확정(codex verify #11).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'skill_quality' AND c.relname = 'worker_candidate_quality'
      AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'skill_quality.worker_candidate_quality 가 VIEW 가 아니거나 없음 — '
      '스킬측 apply-schema 가 불완전합니다(baseline DDL 재적용 필요)';
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA skill_quality TO digisecu_gw_ro';
  -- VIEW 에만 SELECT — base table(worker_candidate_event) 부여 금지.
  EXECUTE 'GRANT SELECT ON skill_quality.worker_candidate_quality TO digisecu_gw_ro';
  -- 방어적 회수(codex verify #7): 다른 경로(엔진 SA_PG_READONLY_ROLE broad-grant 등)가 base
  -- table 을 열어놨어도 여기서 닫는다. (우리 배포에선 그 env 미설정이나 코드가 보장하진 않음.)
  EXECUTE 'REVOKE ALL PRIVILEGES ON skill_quality.worker_candidate_event FROM digisecu_gw_ro';
END
$$;

-- postcondition — 부여는 확정(+), base 접근은 부재(−)까지 검증(조용한 부분 성공 금지).
DO $$
BEGIN
  IF NOT has_table_privilege('digisecu_gw_ro', 'skill_quality.worker_candidate_quality', 'SELECT') THEN
    RAISE EXCEPTION 'postcondition 실패: digisecu_gw_ro 에 worker_candidate_quality SELECT 없음';
  END IF;
  IF has_table_privilege('digisecu_gw_ro', 'skill_quality.worker_candidate_event', 'SELECT') THEN
    RAISE EXCEPTION 'postcondition 실패: digisecu_gw_ro 가 base table(worker_candidate_event)을 '
      '읽을 수 있음 — VIEW-only 기밀성 경계 위반';
  END IF;
END
$$;

-- 확인(선택):
--   SELECT has_table_privilege('digisecu_gw_ro', 'skill_quality.worker_candidate_quality', 'SELECT');
--   SET ROLE digisecu_gw_ro; SELECT count(*) FROM skill_quality.worker_candidate_quality; RESET ROLE;
