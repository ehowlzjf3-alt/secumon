-- 담당자 지정(set_owner) 승인 액션 추가 (2026-09-01)
-- ⚠️ 어휘는 계속 닫아 둔다 — 코드가 새 action 을 만들어도 DB 가 거부해야 한다.
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_action_check";
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_check"
  CHECK ("approvals"."action" in ('hire','terminate','enable_send','delete_pod','budget_override','send_mail','set_owner'));
