/**
 * 예산 admission 계산 (M2.4) — spent는 usage_events 원장에서 읽기 시 계산(projection 컬럼 없음).
 *
 * usage 합·grant 합을 **각각 따로** 집계한다(JOIN 후 SUM 금지 = 행곱 부풀림, codex). SUM(int)은
 * PG에서 bigint → node-pg가 string 반환 → Number(). M2 금액(cents<2^31)은 JS number 안전.
 *
 * 강제(하드스톱)는 이 스냅샷을 resume/hire/override 트랜잭션 안에서 재계산해 409로 막는다.
 * 직렬화는 employee row-lock 규약(usage/resume/grant 모두 FOR UPDATE)으로 보장한다.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AdmissionSnapshot } from "@digisecu/contracts";
import { db } from "./db/client.js";
import { budgetGrants, usageEvents } from "./db/schema.js";

/**
 * 쿼리 실행자 — db 또는 트랜잭션 tx. resume 등 트랜잭션 안에서 호출할 땐 반드시 tx를 넘긴다:
 * tx가 pool client·employee lock을 쥔 채 전역 db(2번째 client)를 요구하면 pool 고갈 데드락(codex#4).
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 고정 billing TZ Asia/Seoul 의 현재 월 1일 (YYYY-MM-01). ambient 서버 TZ 아님. */
export function currentPeriodStart(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

async function sumUsage(exec: Executor, employeeId: string, period: string): Promise<number> {
  const [r] = await exec
    .select({ s: sql<string>`coalesce(sum(${usageEvents.amountCents}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.employeeId, employeeId), eq(usageEvents.periodStart, period)));
  return Number(r?.s ?? 0);
}

async function sumGrants(exec: Executor, employeeId: string, period: string): Promise<number> {
  const [r] = await exec
    .select({ s: sql<string>`coalesce(sum(${budgetGrants.additionalLimitCents}), 0)` })
    .from(budgetGrants)
    .where(and(eq(budgetGrants.employeeId, employeeId), eq(budgetGrants.periodStart, period)));
  return Number(r?.s ?? 0);
}

/**
 * admission 스냅샷 — budget NULL이면 not_configured(비차단). 아니면 spent>=effective면 차단.
 * exec: 트랜잭션 안에서 호출 시 tx를 넘겨 pool 재진입 데드락을 피한다(기본 db는 상세 등 tx 밖 전용).
 */
export async function computeAdmission(
  employeeId: string,
  budgetMonthlyCents: number | null,
  exec: Executor = db,
): Promise<AdmissionSnapshot> {
  const period = currentPeriodStart();
  const spent = await sumUsage(exec, employeeId, period);
  if (budgetMonthlyCents === null) {
    return {
      status: "not_configured",
      blocksAdmission: false,
      budgetCents: null,
      spentCents: spent,
      effectiveBudgetCents: null,
      reason: "예산 미설정 — 하드스톱 비적용",
    };
  }
  const grants = await sumGrants(exec, employeeId, period);
  const effective = budgetMonthlyCents + grants;
  const over = spent >= effective;
  return {
    status: over ? "blocked_over_budget" : "allowed",
    blocksAdmission: over,
    budgetCents: budgetMonthlyCents,
    spentCents: spent,
    effectiveBudgetCents: effective,
    reason: over ? "이번 달 사용액이 유효 예산 이상 — 상향 승인 필요" : null,
  };
}
