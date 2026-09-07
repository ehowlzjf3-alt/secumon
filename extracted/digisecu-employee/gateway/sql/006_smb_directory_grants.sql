-- SMB 노출 표면(공유 → 디렉터리) 읽기 권한.
--
-- 【왜】 티켓 상세가 "이 호스트에서 무엇이 열려 있나" 를 답하려면 디렉터리 목록이 필요하다.
--   같은 화면이 이미 스킬쪽 SMB 운영 웹앱(:8767)에 있고, 그건 엔진 쓰기 롤로 붙어 있다.
--   콘솔은 읽기전용 롤(`digisecu_gw_ro`)이라 지금은 42501 로 막힌다.
--
-- 【무엇을 여는가】 `smb_directory` **하나뿐이다.**
--   · `smb_share` 는 이미 001 에서 부여됐다(큐 카운터용).
--   · 공유별 파일 수는 `smb_share.walk_file_count` 로 충분하다 —
--     ⚠️ `smb_file`(2,020,402행)·`smb_file_hit` 는 **열지 않는다.** 파일 단위 증거는
--        finding 축(`/gw/findings/{id}`)이 이미 답하고, 두 축을 다 열면 같은 사실에
--        출처가 둘이 된다.
--
-- 【경로는 마스킹하지 않는다】 사용자 결정(2026-08-25). 파일 경로 자체가 공정 정보를
--   담을 수 있지만(`…/SEMES_IPDT#08-05-2014…jpg`), :8767 이 이미 같은 ACL 안에서 원문을
--   그대로 보여주고 있고 콘솔도 같은 사내 ACL 사이트다. 두 화면이 다른 값을 보이면
--   그게 더 나쁘다.
--
-- 【실행】
--   psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -f gateway/sql/006_smb_directory_grants.sql
--   ⚠️ 이 스크립트는 **쓰기 롤**로 돌려야 한다(GRANT 는 소유자만 준다).
--   ⚠️ `sql/001` 을 재적용하면 4b 리셋이 SELECT 를 전량 회수한다 — 그때 002~006 을 다시.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'digisecu_gw_ro') THEN
    RAISE EXCEPTION '롤 digisecu_gw_ro 가 없다 — sql/001 을 먼저 돌려라';
  END IF;
END
$$;

GRANT SELECT ON TABLE public.smb_directory TO digisecu_gw_ro;

-- 확인: 부여됐고, 열지 않기로 한 것은 그대로 닫혀 있어야 한다.
DO $$
DECLARE
  opened  int;
  leaked  int;
BEGIN
  SELECT count(*) INTO opened
    FROM information_schema.role_table_grants
   WHERE grantee = 'digisecu_gw_ro' AND table_name = 'smb_directory'
     AND privilege_type = 'SELECT';
  IF opened = 0 THEN
    RAISE EXCEPTION 'smb_directory GRANT 이 안 붙었다';
  END IF;

  SELECT count(*) INTO leaked
    FROM information_schema.role_table_grants
   WHERE grantee = 'digisecu_gw_ro' AND table_name IN ('smb_file', 'smb_file_hit');
  IF leaked > 0 THEN
    RAISE WARNING 'smb_file/smb_file_hit 이 열려 있다 — 이 설계에서는 안 여는 것이 맞다(%건)', leaked;
  END IF;

  RAISE NOTICE 'smb_directory SELECT 부여 완료.';
END
$$;
