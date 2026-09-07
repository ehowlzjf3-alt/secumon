-- ============================================================
-- digisecu 게이트웨이 RO 롤에 임직원 대장 + 저장소 담당자 조회 권한 추가
-- ============================================================
-- 【prod DDL 게이트】 threat_hunter DB 소유자/슈퍼유저로 실행하세요.
--   psql "postgresql://<admin>@<host>:5432/threat_hunter" -v ON_ERROR_STOP=1 -f 005_employee_directory_grants.sql
--
-- 부여 대상 2개: employee_directory · github_repo_owner
--
-- ★ 왜 필요한가 — 게이트웨이는 knox 를 부를 수 없다.
-- 담당자 이름·부서·직급은 사내 knox MCP(`knox_get_employee_info`)에서 오는데, 게이트웨이는
-- DB read-only 라 외부 호출을 하지 않는다(그게 이 서비스의 격리 불변식이다). 그래서 스킬 쪽
-- 수집기가 두 테이블에 적재해 두고 게이트웨이는 **조인만** 한다. 부여가 없으면 화면에는
-- 지금처럼 메일 주소만 뜬다 — 사용자 지시("담당자 이름은 남겨야 한다")가 충족되지 않는다.
--
-- 실측(2026-08-24): finding 이 있는 github 저장소 637개 중
--   repo_login(저장소 소유자가 개인 계정)      … 확정
--   top_contributor(조직 저장소의 1위 기여자)  … 추정
-- 두 근거를 합치면 582개(91%). 나머지는 기여자 0(방치된 템플릿)·404·파트너 계정이다.
--
-- ⚠️ 기밀성 경계 — 이 둘은 **사내 인사정보**다.
-- employee_directory 는 knox_id/full_name/department/en_department/title/employee_number 를 담는다.
-- 게이트웨이가 투영하는 것은 이름·부서·직급 셋뿐이고, **employee_number(사번)는 투영하지 않는다**
-- (식별자로서 이름보다 강하고 화면에 쓸 데가 없다). 새 컬럼을 표면화할 때 이 경계를 다시 볼 것.
-- 이름·부서는 마스킹 대상이 아니다(사용자 결정 2026-08-23) — repos/finding_repo._owner_line 참조.
--
-- 위치: P2 컷오버 전후 어디서 실행해도 되도록 스키마 후보를 순회한다(001 4c 패턴).
-- 실측 시점 실재 위치는 public 이다.
--
-- 멱등: 재실행 안전. ⚠️ sql/001 재적용 시 4b desired-state 리셋이 SELECT 를 전량 회수하므로
-- **sql/001 재적용 후에는 002·003·004 와 함께 이 005 도 다시 실행**해야 합니다.
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  pair text[][] := ARRAY[
    ['skill_smb','employee_directory'],     ['platform','employee_directory'],  ['public','employee_directory'],
    ['skill_github','github_repo_owner'],   ['platform','github_repo_owner'],   ['public','github_repo_owner']
  ];
  i int;
  seen_dir bool := false;
  seen_repo bool := false;
  tbl text;
BEGIN
  FOR i IN 1 .. array_length(pair, 1) LOOP
    tbl := pair[i][2];
    -- 각 테이블은 **먼저 찾은 한 곳만** 부여한다. split-brain(public/skill_* 중복) 상황에서
    -- 양쪽에 주면 게이트웨이가 stale 사본을 읽고도 정상으로 보인다 — 001 4c 와 같은 이유.
    CONTINUE WHEN (tbl = 'employee_directory' AND seen_dir)
               OR (tbl = 'github_repo_owner'  AND seen_repo);
    IF to_regclass(format('%I.%I', pair[i][1], tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO digisecu_gw_ro', pair[i][1]);
      EXECUTE format('GRANT SELECT ON %I.%I TO digisecu_gw_ro', pair[i][1], tbl);
      RAISE NOTICE 'GRANT SELECT ON %.% TO digisecu_gw_ro', pair[i][1], tbl;
      IF tbl = 'employee_directory' THEN seen_dir := true; ELSE seen_repo := true; END IF;
    END IF;
  END LOOP;

  -- fail-loud: 둘 다 없으면 담당자 이름 기능이 조용히 빈 채로 배포된다.
  -- (하나만 있는 상태는 정상일 수 있다 — github 수집만 돌고 다른 도메인은 아직인 경우.)
  IF NOT seen_dir AND NOT seen_repo THEN
    RAISE EXCEPTION 'employee_directory / github_repo_owner 를 어느 스키마에서도 찾지 못했습니다 — '
      '스킬 쪽 담당자 수집(service.services.github_owner.resolve_and_persist)이 '
      '한 번이라도 실행됐는지 확인하세요.';
  END IF;
  IF NOT seen_dir THEN
    RAISE WARNING 'employee_directory 없음 — 담당자 이름·부서가 화면에 안 뜹니다(메일 주소만).';
  END IF;
  IF NOT seen_repo THEN
    RAISE WARNING 'github_repo_owner 없음 — github 담당자가 커밋 작성자 경로로만 잡힙니다.';
  END IF;
END
$$;
