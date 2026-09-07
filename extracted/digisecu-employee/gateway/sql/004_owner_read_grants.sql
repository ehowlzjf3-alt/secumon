-- ============================================================
-- digisecu 게이트웨이 RO 롤에 담당자(asset_owner) + 재검증 결과 4종 조회 권한 추가
-- ============================================================
-- 【사용자님이 직접 실행 — prod DDL 게이트】 threat_hunter DB 소유자/슈퍼유저로 psql 에서 실행하세요.
--   psql "postgresql://<admin>@<host>:5432/threat_hunter" -v ON_ERROR_STOP=1 -f 004_owner_read_grants.sql
--
-- 부여 대상 5개: asset_owner + mail_reverify_result / github_recheck_result /
--               confluence_recheck_result / dev_web_recheck_result
--
-- ★ 왜 필요한가 — 조용한 강등을 없애기 위해서다.
-- `repos/finding_repo.resolve_owner()` 는 SMB 담당자를 `asset_owner` 에서 IP 정확조회로 찾는데,
-- sql/001 의 GRANT 목록 11개에 이 테이블이 **없다**(주석이 "미쿼리 → 미부여" 로 명시). 그런데
-- `_safe_owner()` 의 try/except 가 권한 오류(42501)를 삼켜서, 화면에는 "담당자 없음" 으로 보인다 —
-- 데이터가 없어서가 아니라 못 읽어서인데 그 구분이 사라진다.
-- 실측(2026-08-23): asset_owner 3,207 IP(이름 3,140·부서 3,140·메일 3,185), SMB finding 이 가리키는
-- host 230개가 **230개 전부 매칭**된다. 즉 부여만 하면 SMB 담당자 커버리지는 100% 다.
--
-- 기밀성 경계: 부여는 SELECT 뿐이고, 게이트웨이는 이 테이블에서 user_name/user_dept/email 세 컬럼만
-- 투영한다. email 은 `_owner_email()` 문법검증(단일 메일박스·CRLF/리스트/254자 초과 거부)을 통과한
-- 값만, dssoc 계열은 "담당자 아님" 으로 제외한 뒤 no-store 응답으로 나간다.
-- (사용자 결정: 사내 ACL 사이트라 담당자 목록 노출 허용 — models.ReportThreadItem 주석과 동일 근거.)
--
-- 위치: P2 컷오버 전후 어디서 실행해도 되도록 platform/public 양쪽을 시도한다(001 의 4c 패턴 동일).
-- 실측 시점(2026-08-23) 실재 위치는 public.asset_owner 다.
--
-- 멱등: 재실행 안전. ⚠️ sql/001 재적용 시 4b desired-state 리셋이 관리 스키마 SELECT 를 전량 회수하므로
-- **sql/001 재적용 후에는 002·003 과 함께 이 004 도 다시 실행**해야 합니다.
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  found bool := false;
  sch text;
BEGIN
  FOREACH sch IN ARRAY ARRAY['platform', 'public']
  LOOP
    IF to_regclass(format('%I.asset_owner', sch)) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO digisecu_gw_ro', sch);
      EXECUTE format('GRANT SELECT ON %I.asset_owner TO digisecu_gw_ro', sch);
      RAISE NOTICE 'GRANT SELECT ON %.asset_owner TO digisecu_gw_ro', sch;
      found := true;
      EXIT;  -- target 우선, 먼저 찾은 하나만(split-brain 시 stale 위치 노출 방지 — 001 4c 와 동일)
    END IF;
  END LOOP;

  IF NOT found THEN
    -- fail-loud: 테이블이 없으면 담당자 기능이 조용히 빈 채로 배포된다.
    RAISE EXCEPTION 'asset_owner 테이블을 platform/public 어디에서도 찾지 못했습니다 — '
      'Splunk 자산목록 수집(collector.owner)이 선행됐는지 확인하세요.';
  END IF;
END
$$;

-- ============================================================
-- 2) 재검증 결과 4종 — "조치 완료" 의 유일한 1차 근거
-- ============================================================
-- 개요의 "조치 현황"(발생 대비 조치 완료)이 이 테이블들 없이는 성립하지 않는다. 리포트 스레드의
-- status 만으로는 스레드 단위 종결밖에 못 세는데, 실제로 "다시 확인해보니 닫혀 있더라" 를 기록하는
-- 곳은 여기다(실측 2026-08-23: mail_reverify_result 135행 — now_closed 4 / partially_closed 23 /
-- still_open 98 / communication_unavailable 10. 나머지 3종은 0행).
--
-- 기밀성 경계: 게이트웨이는 이 테이블들에서 **verdict/finding_id/domain 만** 집계에 쓴다.
-- access_json·path_prefix·verification_json 같은 상세 컬럼은 투영하지 않는다(stats_service 참조).
-- 테이블 단위 GRANT 라 권한 자체는 넓어지므로, 새 컬럼을 표면화할 때는 마스킹 경계를 다시 봐야 한다.
--
-- 미존재는 정상이다 — dev_web/confluence 는 스키마만 있고 0행이며, P2 컷오버 전이면 위치가 다르다.
-- 그래서 여기는 fail-loud 가 아니라 to_regclass no-op(sql/002 패턴).
DO $$
DECLARE
  pair text[][] := ARRAY[
    ['skill_smb','mail_reverify_result'],        ['public','mail_reverify_result'],
    ['skill_github','github_recheck_result'],    ['public','github_recheck_result'],
    ['skill_confluence','confluence_recheck_result'], ['public','confluence_recheck_result'],
    ['skill_dev_web','dev_web_recheck_result'],  ['public','dev_web_recheck_result']
  ];
  i int;
  n int := 0;
BEGIN
  FOR i IN 1 .. array_length(pair, 1) LOOP
    IF to_regclass(format('%I.%I', pair[i][1], pair[i][2])) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO digisecu_gw_ro', pair[i][1]);
      EXECUTE format('GRANT SELECT ON %I.%I TO digisecu_gw_ro', pair[i][1], pair[i][2]);
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '재검증 결과 테이블 % 곳에 SELECT 부여', n;
END
$$;

-- 확인 쿼리(선택)
-- SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'digisecu_gw_ro'
--     AND table_name IN ('asset_owner','mail_reverify_result','github_recheck_result',
--                        'confluence_recheck_result','dev_web_recheck_result');
