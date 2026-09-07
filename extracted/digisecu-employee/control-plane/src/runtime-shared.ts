/**
 * 런타임 드라이버 공통(mock/live 공유) — M3.2.
 *
 * 관측(observed lifecycle) 전이의 **부수효과**(presence 보정·주요전이 감사·heartbeat)를 단일 지점으로 모아
 * mock 드라이버와 kubernetes 드라이버가 **동일 계약**으로 DB에 쓰게 한다(codex/렌즈: 직접복사만으론
 * presence·감사 누락). `@kubernetes/client-node` 의존은 여기 없다(kubernetes-driver.ts 에만 격리).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DesiredState, LifecycleState } from "@digisecu/contracts";
import { db } from "./db/client.js";
import { auditLog, employees } from "./db/schema.js";

export type ObservedPhase = LifecycleState;
export type DriverSource = "mock" | "live";

/** 관리 대상 임직원의 최소 스냅샷 — 매니저가 tick 시작 시 DB에서 읽어 드라이버에 넘긴다. */
export interface ManagedEmployee {
  id: string;
  name: string;
  desired: DesiredState;
  observed: ObservedPhase;
  domain: string; // M3.3a: 도메인 ns 라우팅 키(de-domain-<domain>). employees.domain(control-plane 자체 데이터).
}

/** 런타임 회수 대상(M3.2b) — Terminated + 회수 승인된 live 임직원. 드라이버가 CR을 최종 삭제. */
export interface ReclaimTarget {
  id: string;
  name: string;
  domain: string; // M3.3a: 회수할 CR이 있는 도메인 ns.
}

/** 전이 시 presence status 보정 — Paused/Draining/Terminated만; Running/Provisioning은 기존 presence 보존. */
export function statusForTransition(next: ObservedPhase): string | null {
  if (next === "Paused") return "paused";
  if (next === "Draining" || next === "Terminated") return "idle";
  return null;
}

/**
 * 관측 phase 전이를 DB에 원자 적용 — observed CAS(clobber 방지) + presence 보정 + heartbeat + 주요전이 감사.
 * mock(nextPhase 한 스텝)·live(operator status.phase) 공통. 적용되면 true.
 * source 는 감사/meta 출처 표식(mock|live)로만 쓰인다 — 상태 의미는 동일.
 */
export async function applyObservedTransition(
  emp: { id: string; name: string },
  fromObserved: ObservedPhase,
  next: ObservedPhase,
  source: DriverSource,
): Promise<boolean> {
  const st = statusForTransition(next);
  const [u] = await db
    .update(employees)
    .set({ lifecycle: next, heartbeatAt: new Date(), ...(st ? { status: st } : {}) })
    .where(and(eq(employees.id, emp.id), eq(employees.lifecycle, fromObserved))) // observed CAS로 경합 clobber 방지
    .returning({ id: employees.id });
  if (!u) return false;
  // 주요 전이만 감사(드라이버 출처 명시). live의 Terminated 감사 = terminate 위임분(index.ts) 완결.
  if (next === "Running" || next === "Terminated") {
    await db.insert(auditLog).values({
      id: randomUUID(),
      actor: "system",
      action: next === "Running" ? "provisioned" : "terminated",
      targetId: emp.id,
      summary: `${emp.name} → ${next} (${source} 드라이버)`,
      meta: { [source]: true, phase: next },
    });
  }
  return true;
}

/**
 * 성공한 live 관측 tick마다 heartbeat(lastObservedAt) 무조건 갱신 — phase 무변화여도.
 * staleness는 lifecycle 값이 아니라 heartbeat 나이로 판정한다(스키마에 Unknown 없음 → 마이그레이션 회피, 렌즈).
 * lifecycle은 건드리지 않는다(관측 실패 시 stale 유지).
 */
export async function bumpHeartbeat(employeeId: string): Promise<void> {
  await db.update(employees).set({ heartbeatAt: new Date() }).where(eq(employees.id, employeeId));
}

/**
 * 런타임 회수 감사(M3.2b) — CR 최종 삭제 후 emit. lifecycle은 이미 Terminated(회수 게이트 전제)이므로
 * 여기선 상태 변경 없이 회수 사실만 기록한다(terminated 감사는 관측 도달 시 이미 발행됨). employee row는 보존.
 */
export async function emitReclaimAudit(emp: { id: string; name: string }): Promise<void> {
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: "system",
    action: "runtime_reclaimed",
    targetId: emp.id,
    summary: `${emp.name} 런타임 회수 — CR/파드 삭제(live 드라이버)`,
    meta: { live: true, reclaim: true },
  });
}

/**
 * RUNTIME_LIVE_SCOPE(employeeId CSV) 파싱 — kubernetes(live) 드라이버가 관리할 임직원 집합.
 * 빈값(기본) → 전원 mock(= M3.0 무회귀). 비어있지 않으면 그 id만 live, 나머지 mock(하이브리드).
 * 도메인 규칙은 과다범위(codex) — 정확한 id CSV만.
 */
export function parseLiveScope(raw: string | undefined = process.env.RUNTIME_LIVE_SCOPE): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
