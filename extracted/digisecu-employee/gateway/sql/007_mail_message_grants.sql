-- 발송 요청 본문 읽기 권한 (smb).
--
-- 【왜】 콘솔이 "이 대상에 무슨 메일이 나갔나" 를 답하려면 본문이 필요하다. github·confluence·
--   dev_web 은 본문이 `*_report_thread.report_html/report_json` 에 있고 이미 읽힌다.
--   smb 만 `mail_message` 에 있는데 이 롤에 부여돼 있지 않아 42501 이었다.
--
-- 【★ 이 본문은 "발송본" 이 아니다】 저장값은 워커가 `deliver()` 에 넘긴 payload 라
--   egress redact **이전**이다. 실제로 나간(마스킹 후) 본문은 **DB 어디에도 없다** —
--   `mail_message.body_excerpt`·`body_html` 도, `report_html` 도 전부 호출 전 로컬 body 다.
--   그래서 게이트웨이가 읽기 시점에 `masking.redact()` 를 다시 건다(사용자 결정 2026-08-25:
--   "마스킹한 값으로 메일 화면을 띄우면 될 것 같은데"). 결과는 실제 나간 메일보다
--   **더** 가려진 값이다(redact 는 과마스킹 우선). 화면 라벨도 "발송본" 이 아니라
--   **"발송 요청 본문"** 이다.
--
-- 【무엇을 여는가】 `mail_message` 하나뿐. 297행.
--   ⚠️ `platform.service_reply_message`(github/confluence/dev_web 회신 본문)는 **안 연다** —
--      실측 outbound 가 github 1건 규모라 열 이유가 없고, 열면 스키마 경계가 하나 더 늘어난다.
--   ⚠️ `screenshot`·`scan`·`smb_file*` 도 그대로 닫아 둔다.
--
-- 【실행】
--   psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -f gateway/sql/007_mail_message_grants.sql
--   ⚠️ **쓰기 롤**로 돌린다(GRANT 는 소유자만 준다).
--   ⚠️ `sql/001` 재적용 시 SELECT 가 전량 회수된다 — 그때 002~007 을 다시.
--
-- 【되돌리기】
--   REVOKE SELECT ON TABLE public.mail_message FROM digisecu_gw_ro;
--   되돌리면 화면은 "권한 없음" 안내로 돌아간다(본문 없음과 구분해 그린다).

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'digisecu_gw_ro') THEN
    RAISE EXCEPTION '롤 digisecu_gw_ro 가 없다 — sql/001 을 먼저 돌려라';
  END IF;
END
$$;

GRANT SELECT ON TABLE public.mail_message TO digisecu_gw_ro;

DO $$
DECLARE
  opened int;
  leaked int;
BEGIN
  SELECT count(*) INTO opened
    FROM information_schema.role_table_grants
   WHERE grantee = 'digisecu_gw_ro' AND table_name = 'mail_message'
     AND privilege_type = 'SELECT';
  IF opened = 0 THEN
    RAISE EXCEPTION 'mail_message GRANT 이 안 붙었다';
  END IF;

  -- 같이 열려선 안 되는 것들. 열려 있으면 설계가 흐려진 것이니 경고한다.
  SELECT count(*) INTO leaked
    FROM information_schema.role_table_grants
   WHERE grantee = 'digisecu_gw_ro'
     AND table_name IN ('smb_credential', 'credential_probe_attempt', 'screenshot', 'scan');
  IF leaked > 0 THEN
    RAISE WARNING '크리덴셜/스크린샷/원본스캔이 열려 있다 — 이 설계에서는 닫혀 있어야 한다(%건)', leaked;
  END IF;

  RAISE NOTICE 'mail_message SELECT 부여 완료. 본문은 읽기 시점에 재마스킹된다.';
END
$$;
