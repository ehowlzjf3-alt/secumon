/**
 * 예산 하드스톱 계약 — M2.4.
 *
 * admission = 예산 관점의 "지금 활성화/재개 가능한가" 스냅샷. lifecycle과 직교(codex):
 * lifecycle은 고용 상태, admission은 예산 게이트. M2 하드스톱은 activate/resume 거부까지 —
 * 실 파드 중지는 M3. spend 소스는 M3 파드 텔레메트리, M2엔 운영자 수동 usage(dev/demo).
 */
import { z } from "zod";

/** 예산 admission 상태. not_configured 는 M2에선 비차단(정보성) — NULL을 무제한이라 하지 않음. */
export const AdmissionStatus = z.enum(["allowed", "blocked_over_budget", "not_configured"]);
export type AdmissionStatus = z.infer<typeof AdmissionStatus>;

/** admission 스냅샷 — 상세에서만 계산(공용 목록/조직도엔 넣지 않음). 금액은 cents. */
export const AdmissionSnapshot = z.object({
  status: AdmissionStatus,
  blocksAdmission: z.boolean(), // true면 resume/activate 거부(서버 트랜잭션이 강제).
  budgetCents: z.number().int().nullable(), // 기본 월 예산(NULL=미설정).
  spentCents: z.number().int().nonnegative(), // 이번 달(KST) 사용액 합(원장 유도).
  effectiveBudgetCents: z.number().int().nullable(), // budget + 이번 달 grant 합(NULL=미설정).
  reason: z.string().nullable(),
});
export type AdmissionSnapshot = z.infer<typeof AdmissionSnapshot>;

/** 수동 사용액 기록(dev/demo) — 증가 전용. idempotencyKey로 재시도 안전. */
export const UsageRequest = z.object({
  amountCents: z.number().int().positive().max(2_147_483_647),
  idempotencyKey: z.string().min(1).max(200),
  note: z.string().max(200).optional(),
});
export type UsageRequest = z.infer<typeof UsageRequest>;

/** 예산 상향(override) 요청 — 승인 게이트. 예산 hold만 해제, 자동재개 없음. */
export const BudgetOverrideRequest = z.object({
  additionalLimitCents: z.number().int().positive().max(2_147_483_647),
  note: z.string().max(200).optional(),
});
export type BudgetOverrideRequest = z.infer<typeof BudgetOverrideRequest>;
