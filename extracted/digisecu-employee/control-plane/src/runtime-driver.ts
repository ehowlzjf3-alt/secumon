/**
 * 임직원 런타임 드라이버 매니저 (M3.0 → M3.2 하이브리드).
 *
 * control-plane은 **desired**(intent)만 쓰고, 드라이버가 **observed phase**(lifecycle)를 desired로 수렴시킨다.
 * 상태기계 권위는 control-plane, 드라이버는 관측·수렴만(codex 경계).
 *
 * M3.2: 두 서브드라이버를 **함께** 보유하고 임직원을 스코프로 라우팅한다 —
 *  - RUNTIME_LIVE_SCOPE(employeeId CSV) 안 → **kubernetes(live)**: CR write / status read (kubernetes-driver.ts).
 *  - 그 외 → **mock**: in-DB nextPhase 수렴(M3.0 그대로).
 * 빈 스코프(기본) = 전원 mock = M3.0 무회귀. 전역 배타 스위치가 아니라 per-employee 라우팅이라
 * 스코프 밖 임직원이 freeze되지 않고(렌즈), 각 임직원은 정확히 하나의 드라이버 소유(codex: source-mixing 금지).
 *
 * `@kubernetes/client-node`는 kubernetes-driver.ts 에만 있고, 여기서는 **동적 import**로만 로드한다.
 */
import { and, eq, ne } from "drizzle-orm";
import type { DesiredState, RuntimeMode } from "@digisecu/contracts";
import { db } from "./db/client.js";
import { approvals, employees } from "./db/schema.js";
import { applyObservedTransition, parseLiveScope, type ManagedEmployee, type ObservedPhase, type ReclaimTarget } from "./runtime-shared.js";
import type { KubernetesRuntimeDriver } from "./kubernetes-driver.js"; // type-only(로드 안 함 — client-node 격리)

export type { ObservedPhase } from "./runtime-shared.js";

/**
 * 순수 reconcile 스텝(mock 수렴) — desired 향해 observed를 **한 단계** 전진. 테스트 가능.
 * 수렴 시 observed 그대로. 재프로비저닝(Paused→Running)은 Provisioning 경유(현실적 1스텝씩).
 * live 드라이버는 이 함수를 쓰지 않는다(operator가 실 phase 보고 → 직접 복사).
 */
export function nextPhase(desired: DesiredState, observed: ObservedPhase): ObservedPhase {
  if (desired === "Terminated") {
    if (observed === "Terminated") return "Terminated";
    if (observed === "Draining") return "Terminated";
    return "Draining";
  }
  if (desired === "Paused") {
    return "Paused";
  }
  // desired === "Running"
  if (observed === "Running") return "Running";
  if (observed === "Provisioning") return "Running";
  // Paused/Unhealthy/Hired/Draining → 재프로비저닝 경유
  return "Provisioning";
}

// ── 설정(모듈 로드 시 1회) ────────────────────────────────────────────────
// ns는 M3.3a부터 도메인별(de-domain-<domain>) — 드라이버가 employee.domain으로 계산(단일 ns 상수 제거).
const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? `${process.env.HOME ?? ""}/.kube/digisecu-m31.config`;
// live scope는 드라이버 lifecycle과 무관하게 파싱 — toRecord(runtimeModeFor)가 기동 전에도 정직하게 참조.
const liveScope = parseLiveScope();

/** 이 임직원의 관측 phase 출처 — live scope 포함 → live, 아니면 mock. toRecord가 employee별로 파생(하드코딩 제거). */
export function runtimeModeFor(employeeId: string): RuntimeMode {
  return liveScope.has(employeeId) ? "live" : "mock";
}

// ── kubernetes 서브드라이버(지연 초기화) ──────────────────────────────────
let k8sDriver: KubernetesRuntimeDriver | null = null;
let k8sInitFailed = false;

async function ensureK8sDriver(): Promise<KubernetesRuntimeDriver | null> {
  if (k8sDriver || k8sInitFailed || liveScope.size === 0) return k8sDriver;
  try {
    const { createKubernetesDriver } = await import("./kubernetes-driver.js"); // 여기서만 client-node 로드
    k8sDriver = await createKubernetesDriver(KUBECONFIG_PATH);
    // eslint-disable-next-line no-console
    console.log(`[runtime-driver] kubernetes 드라이버 활성 (도메인 ns 격리, live=${liveScope.size}명)`);
  } catch (e) {
    k8sInitFailed = true; // kubeconfig 부재/클러스터 다운 → live 비활성(mock 계속). control-plane 생존.
    // eslint-disable-next-line no-console
    console.error("[runtime-driver] kubernetes 드라이버 초기화 실패 — live 비활성·mock 유지:", (e as Error).message);
  }
  return k8sDriver;
}

// mock 수렴 한 스텝(비-live scope employee만).
async function reconcileMock(emps: ManagedEmployee[]): Promise<void> {
  for (const r of emps) {
    const next = nextPhase(r.desired, r.observed);
    if (next === r.observed) continue;
    await applyObservedTransition(r, r.observed, next, "mock");
  }
}

/** 한 tick — 재직(observed≠Terminated) 임직원을 스코프로 갈라 mock/live 각각 수렴. */
async function tickOnce(): Promise<void> {
  const rows = await db
    .select({ id: employees.id, name: employees.name, desired: employees.desired, lifecycle: employees.lifecycle, domain: employees.domain })
    .from(employees)
    .where(ne(employees.lifecycle, "Terminated")); // 관측 흡수 상태 제외(mock/live 공통 필터)
  const managed: ManagedEmployee[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    desired: r.desired as DesiredState,
    observed: r.lifecycle as ObservedPhase,
    domain: r.domain ?? "", // M3.3a: 도메인 ns 라우팅(빈값=도메인 없음→live 파드 대상 아님)
  }));
  const mockEmps = managed.filter((e) => !liveScope.has(e.id));
  const liveEmps = managed.filter((e) => liveScope.has(e.id));

  await reconcileMock(mockEmps);

  // live 서브드라이버(scope 있을 때만) — sync + 회수 패스.
  if (liveScope.size > 0) {
    const drv = await ensureK8sDriver();
    if (drv) await drv.syncOnce(liveEmps, await reclaimTargets());
  }
}

/**
 * 회수 대상(M3.2b) — 회수 승인(approved delete_pod)된 live-scope 임직원 중 관측이 Terminated에 도달한 것.
 * lifecycle=Terminated 이므로 sync 대상(observed≠Terminated)과 겹치지 않는다. 드라이버가 CR을 최종 삭제.
 */
async function reclaimTargets(): Promise<ReclaimTarget[]> {
  const rows = await db
    .select({ id: employees.id, name: employees.name, domain: employees.domain })
    .from(approvals)
    .innerJoin(employees, eq(approvals.targetId, employees.id))
    .where(and(eq(approvals.action, "delete_pod"), eq(approvals.state, "approved"), eq(employees.lifecycle, "Terminated")));
  return rows.filter((r) => liveScope.has(r.id)).map((r) => ({ id: r.id, name: r.name, domain: r.domain ?? "" }));
}

// ── 자기예약 tick 루프(완료-후-setTimeout) — setInterval 겹침을 원천 차단. ──
let timer: NodeJS.Timeout | undefined;
let started = false;
let stopped = false;
let intervalMs = 2000;

async function runTick(): Promise<void> {
  try {
    await tickOnce();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[runtime-driver] tick 실패:", e);
  }
  if (!stopped) {
    timer = setTimeout(() => void runTick(), intervalMs);
    timer.unref?.();
  }
}

/** 드라이버 시작 — 즉시 첫 tick 후 완료마다 자기예약(직전 tick 미완이면 다음이 시작 안 됨=겹침 없음). */
export function startEmployeeRuntimeDriver(tickMs = 2000): void {
  if (started) return;
  started = true;
  stopped = false;
  intervalMs = tickMs;
  void runTick();
}

export function stopEmployeeRuntimeDriver(): void {
  stopped = true;
  started = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
